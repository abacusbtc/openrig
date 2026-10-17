// opencode seat resume: relaunch the opencode-runner on the persisted session id.
//
// Resume is honest session continuation: the runner opens ACP `session/resume` on <id>,
// and resume only counts as proven when THIS attempt's launch-scoped sidecar is ready AND
// names exactly the requested session. A session opencode no longer has makes the
// runner come up on a different id or exit, both of which are reported as a failed resume,
// never as a silent fresh start.

import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type { SeatLaunchEnvironment } from "../domain/seat-launch-environment.js";
import type { ResumeResult } from "./claude-resume.js";
import { resolveOpencodePosture } from "./opencode-runtime-adapter.js";
import { isOpencodeModelId, opencodeSeatPaths, buildOpencodeRunnerCommand, buildPendingOpencodeRunnerState, parseOpencodeRunnerState } from "./opencode-runner-protocol.js";
import { validateResumeToken } from "../domain/resume-token-validation.js";
import { observeOpencodePermission } from "../domain/permission-drift.js";

export { type ResumeResult };

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

export interface OpencodeResumeFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
}

interface OpencodeResumeOptions {
  seatLaunchEnvironment?: SeatLaunchEnvironment;
  pollMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Launch-attempt id minting (tests inject; defaults to randomUUID). */
  newLaunchId?: () => string;
}

export class OpencodeResumeAdapter {
  constructor(
    private tmux: TmuxAdapter,
    private fs: OpencodeResumeFsOps,
    private paths: { stateRoot: string; runnerEntryPath: string },
    private options: OpencodeResumeOptions = {},
  ) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === "opencode_session_id" && !!resumeToken;
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
      return { ok: false, code: "no_resume", message: "opencode resume not available" };
    }
    const validation = validateResumeToken("opencode", resumeToken);
    if (!validation.ok) {
      return { ok: false, code: "resume_failed", message: `opencode resume failed: ${validation.error}` };
    }
    const sessionId = validation.token;

    const seat = opencodeSeatPaths(this.paths.stateRoot, tmuxSessionName);
    this.fs.mkdirp(seat.seatRoot);

    // Launch-attempt scoping: overwrite any stale sidecar BEFORE typing the command.
    const launchId = (this.options.newLaunchId ?? (() => randomUUID()))();
    const prior = this.fs.exists(seat.runnerStatePath) ? parseOpencodeRunnerState(this.readSafe(seat.runnerStatePath)) : null;
    this.fs.writeFile(
      seat.runnerStatePath,
      JSON.stringify(buildPendingOpencodeRunnerState(launchId, new Date().toISOString(), prior, sessionId)),
    );

    const modelId = model?.trim();
    if (modelId && !isOpencodeModelId(modelId)) {
      return { ok: false, code: "resume_failed", message: `opencode resume failed: model "${modelId}" must be <provider>/<model>` };
    }
    const posture = resolveOpencodePosture(process.env, resolvedPosture);
    const cmd = buildOpencodeRunnerCommand({
      runnerEntryPath: this.paths.runnerEntryPath,
      sessionName: tmuxSessionName,
      stateRoot: this.paths.stateRoot,
      cwd,
      launchId,
      posture,
      model: modelId || undefined,
      sessionId,
    });
    const appliedLaunch = observeOpencodePermission(posture);

    const command = this.options.seatLaunchEnvironment
      ? await this.options.seatLaunchEnvironment.command(tmuxSessionName, cmd, { runtime: "opencode" })
      : cmd;
    let textResult = await this.tmux.sendShellCommand(tmuxSessionName, command, undefined, { stageIfLong: true, execInScript: true });
    if (!textResult.ok && textResult.code === "launch_path_too_long" && command !== cmd) {
      textResult = await this.tmux.sendShellCommand(tmuxSessionName, cmd, undefined, { stageIfLong: true, execInScript: true });
    }
    if (!textResult.ok) {
      return { ok: false, code: "resume_failed", message: textResult.message };
    }
    const result = await this.verifyResume(tmuxSessionName, sessionId, launchId);
    return result.ok ? { ...result, appliedLaunch } : result;
  }

  // Poll the runner's launch-scoped sidecar only, never stale pane scrollback.
  private async verifyResume(tmuxSessionName: string, sessionId: string, launchId: string): Promise<ResumeResult> {
    const pollMs = this.options.pollMs ?? 250;
    const maxWaitMs = this.options.maxWaitMs ?? 30_000;
    const sleepFn = this.options.sleep ?? sleep;
    const attempts = Math.max(1, Math.floor(maxWaitMs / Math.max(pollMs, 1)) + 1);
    const shellGraceAttempts = Math.min(12, Math.floor(attempts / 2));
    let atShellInARow = 0;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const { runnerStatePath } = opencodeSeatPaths(this.paths.stateRoot, tmuxSessionName);
      const state = this.fs.exists(runnerStatePath) ? parseOpencodeRunnerState(this.readSafe(runnerStatePath)) : null;

      if (state?.launchId === launchId) {
        if (state.exited) {
          const paneContent = (await this.tmux.capturePaneContent(tmuxSessionName, 40)) ?? "";
          return {
            ok: false,
            code: "resume_failed",
            message: `opencode resume failed: the runner exited (code ${state.exited.code ?? "unknown"})`,
            evidence: paneContent.split("\n").slice(-12).join("\n"),
          } as ResumeResult;
        }
        if (state.ready) {
          if (state.sessionId !== sessionId) {
            return { ok: false, code: "resume_failed", message: "opencode resume failed: the runner is ready but does not report the requested session" };
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
            message: "opencode resume failed: the pane returned to a shell before the runner reported ready",
            evidence: paneContent.split("\n").slice(-12).join("\n"),
          } as ResumeResult;
        }
      }
      if (attempt < attempts - 1) await sleepFn(pollMs);
    }
    return { ok: false, code: "resume_failed", message: "opencode resume failed: timed out waiting for the runner to prove the requested session" };
  }

  private readSafe(path: string): string {
    try {
      return this.fs.readFile(path);
    } catch {
      return "";
    }
  }
}
