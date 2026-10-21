// opencode runtime adapter.
//
// An opencode seat is a tmux pane running the opencode-runner, which drives `opencode` over
// ACP (Agent Client Protocol) over stdio (see opencode-runner.ts). The adapter launches that runner, proves
// readiness from the runner's launch-scoped sidecar (never pane scraping), and
// projects the seat's guidance and skills into the workspace, where opencode reads
// them: AGENTS.md for guidance and <cwd>/.agents/skills/<id>/ for skills (opencode scans both).
//
// The resume token is the opencode session id. Sessions are stored globally
// under opencode's data dir (~/.local/share/opencode), so a token resumes from any process; the
// adapter cannot check that a session still exists on disk, so a stale id
// surfaces as the runner exiting (readiness fails honestly), never as a silent
// fresh start.

import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import { yoloEnabled, type ResolvedLaunchPosture } from "./yolo-mode.js";
import type {
  RuntimeAdapter, NodeBinding, ResolvedStartupFile, InstalledResource, ProjectionResult,
  StartupDeliveryResult, ReadinessResult, HarnessLaunchResult, ForkSource,
} from "../domain/runtime-adapter.js";
import { resolveConcreteHint } from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import { observeOpencodePermission } from "../domain/permission-drift.js";
import {
  opencodeSeatPaths, buildOpencodeRunnerCommand, buildPendingOpencodeRunnerState, isOpencodeModelId, parseOpencodeRunnerState,
  type OpencodePosture, type OpencodeRunnerState,
} from "./opencode-runner-protocol.js";
import {
  OPENCODE_INTERACTIVE_READY_TEXT, buildOpencodeInteractiveCommand, defaultOpencodeSessionDb, findOpencodeSession,
  opencodeInteractiveStatePath, parseOpencodeInteractiveState, resolveOpencodeSeatMode, waitForOpencodePrompt,
} from "./opencode-interactive.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface OpencodeAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
}

export interface OpencodeRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  fsOps: OpencodeAdapterFsOps;
  /** Root under which every opencode seat gets its runner-state dir. Typically <OPENRIG_HOME>/state/opencode. */
  stateRoot: string;
  /** Absolute path to the compiled opencode-runner entry in the daemon dist. */
  runnerEntryPath: string;
  sleep?: (ms: number) => Promise<void>;
  /** Launch-attempt id minting (tests inject; defaults to randomUUID). */
  newLaunchId?: () => string;
}

/** The posture an opencode seat launches with: an explicit resolved policy is authoritative in
 *  both directions; otherwise the OPENRIG_YOLO environment switch decides. */
export function resolveOpencodePosture(env: NodeJS.ProcessEnv, resolved?: ResolvedLaunchPosture): OpencodePosture {
  if (resolved) return resolved;
  return yoloEnabled(env) ? "full_bypass" : "floor";
}

/** The model for `session/set_config_option`. opencode ids are `<provider>/<model>`; anything else is dropped
 *  by the caller with an error, never passed on to the runner. */
export function opencodeModel(model: string | undefined): string | undefined {
  const value = model?.trim();
  return value ? value : undefined;
}

export class OpencodeRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "opencode";
  private tmux: TmuxAdapter;
  private seatLaunchEnvironment?: SeatLaunchEnvironment;
  private fs: OpencodeAdapterFsOps;
  private stateRoot: string;
  private runnerEntryPath: string;
  private sleep: (ms: number) => Promise<void>;
  private newLaunchId: () => string;

  constructor(deps: OpencodeRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.seatLaunchEnvironment = deps.seatLaunchEnvironment;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.runnerEntryPath = deps.runnerEntryPath;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
  }

  /** The runner-sidecar reader shape resume-token-capture consumes. The session id rides in
   *  the `sessionFile` slot, which that interface names for the Pi/OMP token it was built for. */
  readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string } {
    const interactivePath = opencodeInteractiveStatePath(this.stateRoot, sessionName);
    if (this.fs.exists(interactivePath)) {
      let text = "";
      try {
        text = this.fs.readFile(interactivePath);
      } catch {
        /* unreadable: treated as parse_error below */
      }
      // A headless launch overwrites the marker, so a seat switched back to the runner reads its sidecar.
      if (!text.includes('"headless"')) {
        const interactive = parseOpencodeInteractiveState(text);
        if (!interactive) return { ok: false, reason: "parse_error" };
        const found = findOpencodeSession(interactive, defaultOpencodeSessionDb());
        return found.ok ? { ok: true, sessionFile: found.sessionId } : { ok: false, reason: found.reason };
      }
    }
    const state = this.readRunnerState(sessionName);
    if (state === null) {
      return this.fs.exists(opencodeSeatPaths(this.stateRoot, sessionName).runnerStatePath)
        ? { ok: false, reason: "parse_error" }
        : { ok: false, reason: "missing_sidecar" };
    }
    if (!state.sessionId) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionFile: state.sessionId };
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".agents", "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({ effectiveId: file, category: "skill", installedPath: nodePath.join(skillsDir, file) });
      }
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const warnings: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      // The planner compares only SKILL.md for directory skills; helpers can change
      // independently, so still copy the selected directory on reapply.
      const directorySkill = entry.category === "skill"
        && this.fs.exists(nodePath.join(entry.absolutePath, "SKILL.md"));
      if (entry.classification === "no_op" && !directorySkill) {
        skipped.push(entry.effectiveId);
        continue;
      }
      try {
        if (this.projectEntry(entry, binding, warnings)) projected.push(entry.effectiveId);
        else skipped.push(entry.effectiveId);
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }
    return { projected, skipped, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async deliverStartup(files: ResolvedStartupFile[], binding: NodeBinding): Promise<StartupDeliveryResult> {
    const warnings: string[] = [];
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        const hint = file.deliveryHint === "auto" ? resolveConcreteHint(file.path, content) : file.deliveryHint;
        switch (hint) {
          case "guidance_merge": {
            // opencode reads AGENTS.md from the workspace as a context file.
            const merged = this.mergeGuidance(nodePath.join(binding.cwd, "AGENTS.md"), file.path, content, warnings);
            if (!merged) continue; // rig-role skip: do not count as delivered
            break;
          }
          case "skill_install": {
            const targetDir = nodePath.join(binding.cwd, ".agents", "skills", nodePath.basename(nodePath.dirname(file.absolutePath)));
            this.fs.mkdirp(targetDir);
            this.fs.writeFile(nodePath.join(targetDir, nodePath.basename(file.path)), content);
            break;
          }
          case "send_text": {
            if (binding.tmuxSession) {
              // The runner reads pane stdin and forwards it to opencode as the next user turn.
              const textResult = await this.tmux.sendText(binding.tmuxSession, content);
              if (!textResult.ok) throw new Error(textResult.message);
              await this.sleep(200);
              const submitResult = await this.tmux.sendKeys(binding.tmuxSession, ["Enter"]);
              if (!submitResult.ok) throw new Error(submitResult.message);
            }
            break;
          }
        }
        delivered++;
      } catch (err) {
        if (file.required) failed.push({ path: file.path, error: (err as Error).message });
      }
    }
    return { delivered, failed, ...(warnings.length ? { warnings } : {}) };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch the opencode harness" };
    }
    if (opts.forkSource) {
      // ACP offers session/fork, but the runner does not drive it yet. Refusing is honest; starting fresh would lose the fork's point.
      return { ok: false, error: "opencode fork is not supported yet: resume the session or start a new seat" };
    }

    let sessionId: string | undefined;
    if (opts.resumeToken) {
      const validation = validateResumeToken("opencode", opts.resumeToken);
      if (!validation.ok) return { ok: false, error: `opencode resume: ${validation.error}` };
      sessionId = validation.token;
    }

    const model = opencodeModel(binding.model);
    if (model && !isOpencodeModelId(model)) {
      return { ok: false, error: `opencode launch: model "${model}" must be <provider>/<model> (for example opencode/glm-5.3-flash-free)` };
    }

    const sessionName = binding.tmuxSession;
    if ((await resolveOpencodeSeatMode(this.tmux, sessionName)) === "interactive") {
      return this.launchInteractive(binding, sessionName, model, sessionId);
    }
    const paths = opencodeSeatPaths(this.stateRoot, sessionName);
    this.fs.mkdirp(paths.seatRoot);

    // Launch-attempt scoping: overwrite any stale sidecar with a pending record BEFORE the
    // command is typed, and trust only sidecar states stamped with THIS attempt's launchId.
    const launchId = this.newLaunchId();
    if (this.fs.exists(opencodeInteractiveStatePath(this.stateRoot, sessionName))) {
      // A headless launch retires the interactive marker, so the seat reads its runner sidecar again.
      this.fs.writeFile(opencodeInteractiveStatePath(this.stateRoot, sessionName), JSON.stringify({ mode: "headless" }));
    }
    const prior = this.readRunnerState(sessionName);
    this.fs.writeFile(
      paths.runnerStatePath,
      JSON.stringify(buildPendingOpencodeRunnerState(launchId, new Date().toISOString(), prior, sessionId)),
    );

    const posture = resolveOpencodePosture(process.env, binding.launchPosture);
    const cmd = buildOpencodeRunnerCommand({
      runnerEntryPath: this.runnerEntryPath,
      sessionName,
      stateRoot: this.stateRoot,
      cwd: binding.cwd,
      launchId,
      posture,
      model,
      sessionId,
    });
    const appliedLaunch = observeOpencodePermission(posture);

    const command = this.seatLaunchEnvironment
      ? await this.seatLaunchEnvironment.command(sessionName, cmd, { nodeId: binding.nodeId, generation: binding.launchGeneration, runtime: "opencode" })
      : cmd;
    let textResult = await this.tmux.sendShellCommand(sessionName, command, undefined, { stageIfLong: true, execInScript: true });
    if (!textResult.ok && textResult.code === "launch_path_too_long" && command !== cmd) {
      textResult = await this.tmux.sendShellCommand(sessionName, cmd, undefined, { stageIfLong: true, execInScript: true });
    }
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }

    const state = await this.waitForRunnerReady(sessionName, launchId);
    if (!state.ok) return state.failure;

    const reported = state.value.sessionId;
    if (!reported) {
      return { ok: false, error: "opencode launch: the runner became ready but reported no session id" };
    }
    if (sessionId && reported !== sessionId) {
      return { ok: false, error: "opencode resume: the runner is ready but does not report the requested session", recovery: "attention_required" };
    }
    const validation = validateResumeToken("opencode", reported);
    if (!validation.ok) {
      return { ok: false, error: `opencode launch: the runner reported a malformed session id (${validation.error})` };
    }
    return { ok: true, resumeToken: validation.token, resumeType: "opencode_session_id", appliedLaunch };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    if (!(await this.tmux.hasSession(binding.tmuxSession))) {
      return { ready: false, reason: "tmux session not responsive" };
    }
    // A sidecar or scrollback marker can outlive the runner process, so a ready signal counts only
    // while the pane's foreground process is not back at a shell.
    const paneCommand = (await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "";
    // A login shell reports its name with a leading dash ("-bash").
    const atShell = SHELL_COMMANDS.has(paneCommand.replace(/^-/, ""));
    if ((await resolveOpencodeSeatMode(this.tmux, binding.tmuxSession)) === "interactive") {
      return this.checkInteractiveReady(binding.tmuxSession, atShell);
    }
    const state = this.readRunnerState(binding.tmuxSession);
    if (state?.exited) {
      return { ready: false, reason: `opencode-runner exited (code ${state.exited.code ?? "unknown"})`, code: "runner_exited" };
    }
    if (state?.ready) {
      if (atShell) {
        return { ready: false, reason: "opencode-runner sidecar says ready but the pane is back at a shell (runner process gone)", code: "runner_exited" };
      }
      return { ready: true };
    }
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    if (paneContent.includes("[opencode-runner] ERROR")) {
      return { ready: false, reason: "opencode-runner reported an error in the pane", code: "runner_error" };
    }
    if (paneContent.includes("[opencode-runner] EXITED")) {
      return { ready: false, reason: "opencode-runner exited", code: "runner_exited" };
    }
    // A runner that wrote a sidecar speaks for itself: not-yet-ready (booting, or restarting after a
    // cancel) must not be overridden by an earlier READY line still in scrollback.
    if (state) return { ready: false, reason: "opencode-runner has not reported ready yet", code: "awaiting_runtime" };
    if (paneContent.includes("[opencode-runner] READY")) {
      if (atShell) {
        return { ready: false, reason: "READY marker is stale scrollback; the pane is back at a shell", code: "runner_exited" };
      }
      return { ready: true };
    }
    return { ready: false, reason: "opencode-runner has not reported ready yet", code: "awaiting_runtime" };
  }

  // ── interactive mode ────────────────────────────────────────────────────────
  /** Fresh or resumed start of opencode's own TUI. Readiness is the pane (opencode is the foreground
   *  process and shows its input placeholder). There is no runner sidecar, so the launch records
   *  interactive.json and the session id is found later from opencode's global sqlite store
   *  (see opencode-interactive.ts). */
  private async launchInteractive(
    binding: NodeBinding,
    sessionName: string,
    model: string | undefined,
    sessionId?: string,
  ): Promise<HarnessLaunchResult> {
    const posture = resolveOpencodePosture(process.env, binding.launchPosture);
    const cmd = buildOpencodeInteractiveCommand({ model, sessionId });
    const appliedLaunch = observeOpencodePermission(posture);
    this.fs.mkdirp(opencodeSeatPaths(this.stateRoot, sessionName).seatRoot);
    this.fs.writeFile(
      opencodeInteractiveStatePath(this.stateRoot, sessionName),
      JSON.stringify({ mode: "interactive", launchedAtMs: Date.now(), cwd: binding.cwd, ...(sessionId ? { sessionId } : {}) }),
    );
    const command = this.seatLaunchEnvironment
      ? await this.seatLaunchEnvironment.command(sessionName, cmd, { nodeId: binding.nodeId, generation: binding.launchGeneration, runtime: "opencode" })
      : cmd;
    let textResult = await this.tmux.sendShellCommand(sessionName, command, undefined, { stageIfLong: true, execInScript: true });
    if (!textResult.ok && textResult.code === "launch_path_too_long" && command !== cmd) {
      textResult = await this.tmux.sendShellCommand(sessionName, cmd, undefined, { stageIfLong: true, execInScript: true });
    }
    if (!textResult.ok) return { ok: false, error: `Failed to send launch command: ${textResult.message}` };

    const wait = await waitForOpencodePrompt(this.tmux, sessionName, this.sleep);
    if (wait.ok) return { ok: true, appliedLaunch };
    if (wait.kind === "shell") {
      return { ok: false, error: "opencode launch failed: the pane returned to a shell before opencode showed its prompt", recovery: "attention_required", evidence: wait.evidence };
    }
    return { ok: false, error: "opencode launch: timed out waiting for opencode to show its prompt", recovery: "attention_required" };
  }

  private async checkInteractiveReady(sessionName: string, atShell: boolean): Promise<ReadinessResult> {
    if (atShell) return { ready: false, reason: "opencode is not running; the pane is back at a shell", code: "runner_exited" };
    const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
    return paneContent.includes(OPENCODE_INTERACTIVE_READY_TEXT)
      ? { ready: true }
      : { ready: false, reason: "opencode has not shown its prompt yet", code: "awaiting_runtime" };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private readRunnerState(sessionName: string): OpencodeRunnerState | null {
    const { runnerStatePath } = opencodeSeatPaths(this.stateRoot, sessionName);
    if (!this.fs.exists(runnerStatePath)) return null;
    try {
      return parseOpencodeRunnerState(this.fs.readFile(runnerStatePath));
    } catch {
      return null;
    }
  }

  private async waitForRunnerReady(
    sessionName: string,
    launchId: string,
  ): Promise<{ ok: true; value: OpencodeRunnerState } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = 250;
    // opencode emits `init` right at startup; the longer budget covers a cold start of the opencode binary.
    const attempts = 120; // ~30s
    const shellGraceAttempts = 12; // ~3s for the typed command to become the node process
    let atShellInARow = 0;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = this.readRunnerState(sessionName);
      if (state?.launchId === launchId) {
        if (state.exited) {
          const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
          return {
            ok: false,
            failure: {
              ok: false,
              error: `opencode launch failed: the runner exited (code ${state.exited.code ?? "unknown"})`,
              recovery: "attention_required",
              evidence: paneContent.split("\n").slice(-12).join("\n"),
            },
          };
        }
        if (state.ready) return { ok: true, value: state };
      }
      // The runner can die before it ever writes its own sidecar (node missing, bad entry path, a
      // shell syntax error), leaving only our pending record. A pane that stays at a shell after the
      // grace period means nothing is running, so fail now instead of waiting out the full timeout.
      if (attempt >= shellGraceAttempts) {
        const paneCommand = ((await this.tmux.getPaneCommand(sessionName)) ?? "").replace(/^-/, "");
        atShellInARow = SHELL_COMMANDS.has(paneCommand) ? atShellInARow + 1 : 0;
        if (atShellInARow >= 2) {
          const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
          return {
            ok: false,
            failure: {
              ok: false,
              error: "opencode launch failed: the pane returned to a shell before the runner reported ready",
              recovery: "attention_required",
              evidence: paneContent.split("\n").slice(-12).join("\n"),
            },
          };
        }
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      failure: { ok: false, error: "opencode launch: timed out waiting for the runner to report ready", recovery: "attention_required" },
    };
  }

  private projectEntry(entry: ProjectionEntry, binding: NodeBinding, warnings: string[]): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      return this.mergeGuidance(nodePath.join(binding.cwd, "AGENTS.md"), entry.effectiveId, this.fs.readFile(entry.absolutePath), warnings);
    }

    if (entry.category === "skill") {
      const targetDir = nodePath.join(binding.cwd, ".agents", "skills", entry.effectiveId);
      this.fs.mkdirp(targetDir);
      let isDir = false;
      if (this.fs.listFiles) {
        try {
          isDir = this.fs.listFiles(entry.absolutePath).length > 0;
        } catch {
          // File-shaped sources make the production recursive walk throw ENOTDIR.
          isDir = false;
        }
      }
      if (isDir && this.fs.listFiles) {
        for (const file of this.fs.listFiles(entry.absolutePath)) {
          const dest = nodePath.join(targetDir, file);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, this.fs.readFile(nodePath.join(entry.absolutePath, file)));
          this.preserveMode(nodePath.join(entry.absolutePath, file), dest);
        }
      } else {
        const dest = nodePath.join(targetDir, nodePath.basename(entry.absolutePath));
        this.fs.writeFile(dest, this.fs.readFile(entry.absolutePath));
        this.preserveMode(entry.absolutePath, dest);
      }
      return true;
    }

    // Plugins, subagents and runtime resources have no opencode projection target: an honest skip.
    return false;
  }

  private preserveMode(source: string, target: string): void {
    if (this.fs.statMode && this.fs.chmod) this.fs.chmod(target, this.fs.statMode(source) & 0o777);
  }

  private mergeGuidance(targetPath: string, blockId: string, content: string, warnings: string[]): boolean {
    // Per-seat `rig-role` content collides across pod-mates in a shared cwd file; it is
    // delivered via send_text instead (ADR-0006), same as the other adapters.
    if (blockId === "rig-role") {
      console.log(`[openrig] skip: effectiveId is rig-role, per-seat delivery via send_text path required (target=${targetPath})`);
      return false;
    }
    mergeManagedBlock(this.fs, targetPath, blockId, content, {
      warnings,
      replaceBlockIds: blockId === "openrig-start.md" ? ["using-openrig.md"] : [],
    });
    return true;
  }
}
