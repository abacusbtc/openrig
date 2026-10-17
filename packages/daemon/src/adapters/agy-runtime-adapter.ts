// agy (Antigravity CLI) runtime adapter.
//
// An agy seat is a tmux pane running the agy-runner, which drives `agy` over
// stream-json (see agy-runner.ts). The adapter launches that runner, proves
// readiness from the runner's launch-scoped sidecar (never pane scraping), and
// projects the seat's guidance and skills into the workspace, where agy reads
// them: AGENTS.md for guidance and <cwd>/.agents/skills/<id>/ for skills.
//
// The resume token is the agy conversation id. Conversations are stored globally
// under ~/.gemini/antigravity-cli, so a token resumes from any process; the
// adapter cannot check that a conversation still exists on disk, so a stale id
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
import { observeAgyPermission } from "../domain/permission-drift.js";
import {
  AGY_EFFORTS, agySeatPaths, buildAgyRunnerCommand, buildPendingAgyRunnerState, parseAgyRunnerState,
  type AgyPosture, type AgyRunnerState,
} from "./agy-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface AgyAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
}

export interface AgyRuntimeAdapterDeps {
  tmux: TmuxAdapter;
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  fsOps: AgyAdapterFsOps;
  /** Root under which every agy seat gets its runner-state dir. Typically <OPENRIG_HOME>/state/agy. */
  stateRoot: string;
  /** Absolute path to the compiled agy-runner entry in the daemon dist. */
  runnerEntryPath: string;
  sleep?: (ms: number) => Promise<void>;
  /** Launch-attempt id minting (tests inject; defaults to randomUUID). */
  newLaunchId?: () => string;
}

/** The posture an agy seat launches with: an explicit resolved policy is authoritative in
 *  both directions; otherwise the OPENRIG_YOLO environment switch decides. */
export function resolveAgyPosture(env: NodeJS.ProcessEnv, resolved?: ResolvedLaunchPosture): AgyPosture {
  if (resolved) return resolved;
  return yoloEnabled(env) ? "full_bypass" : "floor";
}

/** agy takes `--effort low|medium|high|xhigh|max`; anything else on the binding is dropped, never passed on. */
export function agyEffort(effort: string | undefined): string | undefined {
  const value = effort?.trim();
  return value && (AGY_EFFORTS as readonly string[]).includes(value) ? value : undefined;
}

export class AgyRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "agy";
  private tmux: TmuxAdapter;
  private seatLaunchEnvironment?: SeatLaunchEnvironment;
  private fs: AgyAdapterFsOps;
  private stateRoot: string;
  private runnerEntryPath: string;
  private sleep: (ms: number) => Promise<void>;
  private newLaunchId: () => string;

  constructor(deps: AgyRuntimeAdapterDeps) {
    this.tmux = deps.tmux;
    this.seatLaunchEnvironment = deps.seatLaunchEnvironment;
    this.fs = deps.fsOps;
    this.stateRoot = deps.stateRoot;
    this.runnerEntryPath = deps.runnerEntryPath;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
  }

  /** The runner-sidecar reader shape resume-token-capture consumes. The conversation id rides in
   *  the `sessionFile` slot, which that interface names for the Pi/OMP token it was built for. */
  readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string } {
    const state = this.readRunnerState(sessionName);
    if (state === null) {
      return this.fs.exists(agySeatPaths(this.stateRoot, sessionName).runnerStatePath)
        ? { ok: false, reason: "parse_error" }
        : { ok: false, reason: "missing_sidecar" };
    }
    if (!state.conversationId) return { ok: false, reason: "missing_sidecar" };
    return { ok: true, sessionFile: state.conversationId };
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
            // agy reads AGENTS.md from the workspace as a context file.
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
              // The runner reads pane stdin and forwards it to agy as the next user turn.
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
      return { ok: false, error: "No tmux session bound — cannot launch the agy harness" };
    }
    if (opts.forkSource) {
      // agy has no conversation fork. Refusing is honest; starting fresh would lose the fork's point.
      return { ok: false, error: "agy fork is not supported: agy cannot branch a conversation; resume it or start a new seat" };
    }

    let conversationId: string | undefined;
    if (opts.resumeToken) {
      const validation = validateResumeToken("agy", opts.resumeToken);
      if (!validation.ok) return { ok: false, error: `agy resume: ${validation.error}` };
      conversationId = validation.token;
    }

    const sessionName = binding.tmuxSession;
    const paths = agySeatPaths(this.stateRoot, sessionName);
    this.fs.mkdirp(paths.seatRoot);

    // Launch-attempt scoping: overwrite any stale sidecar with a pending record BEFORE the
    // command is typed, and trust only sidecar states stamped with THIS attempt's launchId.
    const launchId = this.newLaunchId();
    const prior = this.readRunnerState(sessionName);
    this.fs.writeFile(
      paths.runnerStatePath,
      JSON.stringify(buildPendingAgyRunnerState(launchId, new Date().toISOString(), prior, conversationId)),
    );

    const posture = resolveAgyPosture(process.env, binding.launchPosture);
    const cmd = buildAgyRunnerCommand({
      runnerEntryPath: this.runnerEntryPath,
      sessionName,
      stateRoot: this.stateRoot,
      cwd: binding.cwd,
      launchId,
      posture,
      model: binding.model,
      effort: agyEffort(binding.effort),
      conversationId,
    });
    const appliedLaunch = observeAgyPermission(posture);

    const command = this.seatLaunchEnvironment
      ? await this.seatLaunchEnvironment.command(sessionName, cmd, { nodeId: binding.nodeId, generation: binding.launchGeneration, runtime: "agy" })
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

    const reported = state.value.conversationId;
    if (!reported) {
      return { ok: false, error: "agy launch: the runner became ready but reported no conversation id" };
    }
    if (conversationId && reported !== conversationId) {
      return { ok: false, error: "agy resume: the runner is ready but does not report the requested conversation", recovery: "attention_required" };
    }
    const validation = validateResumeToken("agy", reported);
    if (!validation.ok) {
      return { ok: false, error: `agy launch: the runner reported a malformed conversation id (${validation.error})` };
    }
    return { ok: true, resumeToken: validation.token, resumeType: "agy_conversation_id", appliedLaunch };
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) return { ready: false, reason: "No tmux session bound" };
    if (!(await this.tmux.hasSession(binding.tmuxSession))) {
      return { ready: false, reason: "tmux session not responsive" };
    }
    // A sidecar or scrollback marker can outlive the runner process, so a ready signal counts only
    // while the pane's foreground process is not back at a shell.
    const paneCommand = (await this.tmux.getPaneCommand(binding.tmuxSession)) ?? "";
    const atShell = SHELL_COMMANDS.has(paneCommand);
    const state = this.readRunnerState(binding.tmuxSession);
    if (state?.exited) {
      return { ready: false, reason: `agy-runner exited (code ${state.exited.code ?? "unknown"})`, code: "runner_exited" };
    }
    if (state?.ready) {
      if (atShell) {
        return { ready: false, reason: "agy-runner sidecar says ready but the pane is back at a shell (runner process gone)", code: "runner_exited" };
      }
      return { ready: true };
    }
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    if (paneContent.includes("[agy-runner] ERROR")) {
      return { ready: false, reason: "agy-runner reported an error in the pane", code: "runner_error" };
    }
    if (paneContent.includes("[agy-runner] EXITED")) {
      return { ready: false, reason: "agy-runner exited", code: "runner_exited" };
    }
    if (paneContent.includes("[agy-runner] READY")) {
      if (atShell) {
        return { ready: false, reason: "READY marker is stale scrollback; the pane is back at a shell", code: "runner_exited" };
      }
      return { ready: true };
    }
    return { ready: false, reason: "agy-runner has not reported ready yet", code: "awaiting_runtime" };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private readRunnerState(sessionName: string): AgyRunnerState | null {
    const { runnerStatePath } = agySeatPaths(this.stateRoot, sessionName);
    if (!this.fs.exists(runnerStatePath)) return null;
    try {
      return parseAgyRunnerState(this.fs.readFile(runnerStatePath));
    } catch {
      return null;
    }
  }

  private async waitForRunnerReady(
    sessionName: string,
    launchId: string,
  ): Promise<{ ok: true; value: AgyRunnerState } | { ok: false; failure: HarnessLaunchResult }> {
    const pollMs = 250;
    // agy emits `init` right at startup; the longer budget covers a cold start of the agy binary.
    const attempts = 120; // ~30s
    for (let attempt = 0; attempt < attempts; attempt++) {
      const state = this.readRunnerState(sessionName);
      if (state?.launchId === launchId) {
        if (state.exited) {
          const paneContent = (await this.tmux.capturePaneContent(sessionName, 40)) ?? "";
          return {
            ok: false,
            failure: {
              ok: false,
              error: `agy launch failed: the runner exited (code ${state.exited.code ?? "unknown"})`,
              recovery: "attention_required",
              evidence: paneContent.split("\n").slice(-12).join("\n"),
            },
          };
        }
        if (state.ready) return { ok: true, value: state };
      }
      if (attempt < attempts - 1) await this.sleep(pollMs);
    }
    return {
      ok: false,
      failure: { ok: false, error: "agy launch: timed out waiting for the runner to report ready", recovery: "attention_required" },
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

    // Plugins, subagents and runtime resources have no agy projection target: an honest skip.
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
