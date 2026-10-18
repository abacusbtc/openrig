// agy seat resume: relaunch the agy-runner on the persisted conversation id.
//
// Resume is honest conversation continuation: the runner starts `agy --conversation <id>`,
// and resume only counts as proven when THIS attempt's launch-scoped sidecar is ready AND
// names exactly the requested conversation. A conversation agy no longer has makes the
// runner come up on a different id or exit, both of which are reported as a failed resume,
// never as a silent fresh start. (The effort setting is not part of the restore call, so
// a restored seat runs at agy's default effort.)

import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import type { ResumeResult } from "./claude-resume.js";
import { resolveAgyPosture } from "./agy-runtime-adapter.js";
import {
  agySeatPaths, buildAgyInteractiveCommand, buildAgyRunnerCommand, buildPendingAgyRunnerState, parseAgyRunnerState,
} from "./agy-runner-protocol.js";
import { agyInteractiveStatePath, resolveAgySeatMode, waitForAgyPrompt } from "./agy-interactive.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { observeAgyPermission } from "../domain/permission-drift.js";

export { type ResumeResult };

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface AgyResumeFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
}

interface AgyResumeOptions {
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Launch-attempt id minting (tests inject; defaults to randomUUID). */
  newLaunchId?: () => string;
}

export class AgyResumeAdapter {
  constructor(
    private tmux: TmuxAdapter,
    private fs: AgyResumeFsOps,
    private paths: { stateRoot: string; runnerEntryPath: string },
    private options: AgyResumeOptions = {},
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === "agy_conversation_id" && !!resumeToken;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    model?: string | null,
    resolvedPosture?: "floor" | "full_bypass" | "auto",
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "agy resume not available" };
    }
    const validation = validateResumeToken("agy", resumeToken);
    if (!validation.ok) {
      return { ok: false, code: "resume_failed", message: `agy resume failed: ${validation.error}` };
    }
    const conversationId = validation.token;

    const seat = agySeatPaths(this.paths.stateRoot, tmuxSessionName);
    this.fs.mkdirp(seat.seatRoot);

    // Launch-attempt scoping: overwrite any stale sidecar BEFORE typing the command.
    const launchId = (this.options.newLaunchId ?? (() => randomUUID()))();
    const prior = this.fs.exists(seat.runnerStatePath) ? parseAgyRunnerState(this.readSafe(seat.runnerStatePath)) : null;
    this.fs.writeFile(
      seat.runnerStatePath,
      JSON.stringify(buildPendingAgyRunnerState(launchId, new Date().toISOString(), prior, conversationId)),
    );

    const posture = resolveAgyPosture(process.env, resolvedPosture);
    if ((await resolveAgySeatMode(this.tmux, tmuxSessionName)) === "interactive") {
      return this.resumeInteractive(tmuxSessionName, conversationId, posture, model ?? undefined);
    }
    const cmd = buildAgyRunnerCommand({
      runnerEntryPath: this.paths.runnerEntryPath,
      sessionName: tmuxSessionName,
      stateRoot: this.paths.stateRoot,
      cwd,
      launchId,
      posture,
      model: model ?? undefined,
      conversationId,
    });
    const appliedLaunch = observeAgyPermission(posture);

    const command = this.options.seatLaunchEnvironment
      ? await this.options.seatLaunchEnvironment.command(tmuxSessionName, cmd, { runtime: "agy" })
      : cmd;
    let textResult = await this.tmux.sendShellCommand(tmuxSessionName, command, undefined, { stageIfLong: true, execInScript: true });
    if (!textResult.ok && textResult.code === "launch_path_too_long" && command !== cmd) {
      textResult = await this.tmux.sendShellCommand(tmuxSessionName, cmd, undefined, { stageIfLong: true, execInScript: true });
    }
    if (!textResult.ok) {
      return { ok: false, code: "resume_failed", message: textResult.message };
    }
    const result = await this.verifyResume(tmuxSessionName, conversationId, launchId);
    return result.ok ? { ...result, appliedLaunch } : result;
  }

  /** Interactive seats resume as `agy --conversation <id>` in the pane; proof is the console's prompt. */
  private async resumeInteractive(
    tmuxSessionName: string,
    conversationId: string,
    posture: ReturnType<typeof resolveAgyPosture>,
    model: string | undefined,
  ): Promise<ResumeResult> {
    const cmd = buildAgyInteractiveCommand({ posture, model, conversationId });
    const appliedLaunch = observeAgyPermission(posture);
    this.fs.mkdirp(agySeatPaths(this.paths.stateRoot, tmuxSessionName).seatRoot);
    this.fs.writeFile(
      agyInteractiveStatePath(this.paths.stateRoot, tmuxSessionName),
      JSON.stringify({ mode: "interactive", launchedAtMs: Date.now(), conversationId }),
    );
    const command = this.options.seatLaunchEnvironment
      ? await this.options.seatLaunchEnvironment.command(tmuxSessionName, cmd, { runtime: "agy" })
      : cmd;
    let textResult = await this.tmux.sendShellCommand(tmuxSessionName, command, undefined, { stageIfLong: true, execInScript: true });
    if (!textResult.ok && textResult.code === "launch_path_too_long" && command !== cmd) {
      textResult = await this.tmux.sendShellCommand(tmuxSessionName, cmd, undefined, { stageIfLong: true, execInScript: true });
    }
    if (!textResult.ok) return { ok: false, code: "resume_failed", message: textResult.message };
    const wait = await waitForAgyPrompt(this.tmux, tmuxSessionName, this.options.sleep ?? sleep);
    if (wait.ok) return { ok: true, appliedLaunch };
    const why = wait.kind === "trust" ? "the workspace is not trusted by agy (see trustedWorkspaces)"
      : wait.kind === "shell" ? "the pane returned to a shell before agy showed its prompt"
      : "timed out waiting for agy to show its prompt";
    return { ok: false, code: "resume_failed", message: `agy resume failed: ${why}`, evidence: wait.evidence } as ResumeResult;
  }

  // Poll the runner's launch-scoped sidecar only, never stale pane scrollback.
  private async verifyResume(tmuxSessionName: string, conversationId: string, launchId: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 250;
    const maxWaitMs = this.options.maxWaitMs ?? 30_000;
    const sleepFn = this.options.sleep ?? sleep;
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);
    const shellGraceAttempts = Math.min(12, Math.floor(attempts / 2));
    let atShellInARow = 0;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const { runnerStatePath } = agySeatPaths(this.paths.stateRoot, tmuxSessionName);
      const state = this.fs.exists(runnerStatePath) ? parseAgyRunnerState(this.readSafe(runnerStatePath)) : null;

      if (state?.launchId === launchId) {
        if (state.exited) {
          const paneContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
          return {
            ok: false,
            code: "resume_failed",
            message: `agy resume failed: the runner exited (code ${state.exited.code ?? "unknown"})`,
            evidence: paneContent.split("\n").slice(-12).join("\n"),
          } as ResumeResult;
        }
        if (state.ready) {
          if (state.conversationId !== conversationId) {
            return { ok: false, code: "resume_failed", message: "agy resume failed: the runner is ready but does not report the requested conversation" };
          }
          return { ok: true };
        }
      }
      // A runner that died before writing its own sidecar leaves only our pending record; a pane
      // that stays at a shell after the grace period means nothing is running, so fail now.
      if (attempt >= shellGraceAttempts) {
        const paneCommand = ((await this.tmux.getPaneCommand(tmuxSessionName)) ?? "").replace(/^-/, "");
        atShellInARow = SHELL_COMMANDS.has(paneCommand) ? atShellInARow + 1 : 0;
        if (atShellInARow >= 2) {
          const paneContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
          return {
            ok: false,
            code: "resume_failed",
            message: "agy resume failed: the pane returned to a shell before the runner reported ready",
            evidence: paneContent.split("\n").slice(-12).join("\n"),
          } as ResumeResult;
        }
      }
      if (attempt < attempts - 1) await sleepFn(pollMs);
    }
    return { ok: false, code: "resume_failed", message: "agy resume failed: timed out waiting for the runner to prove the requested conversation" };
  }

  private readSafe(path: string): string {
    try {
      return this.fs.readFile(path);
    } catch {
      return "";
    }
  }
}
