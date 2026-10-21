// Interactive opencode seats: opencode's own TUI runs in the pane, with no runner and so no sidecar
// naming the session. This file holds the two pieces that make that work:
//   - waiting for the TUI's prompt (shared by launch and readiness), and
//   - finding the opencode session id. opencode records every session in its global sqlite store
//     (~/.local/share/opencode/opencode.db, table `session_v2`), stamped with the directory it
//     opened and the epoch-ms creation time, so the id is the row that appeared after the seat
//     launched. If more than one appeared (two seats took their first turn in the same window)
//     the seat cannot tell which is its own, so it reports none rather than risk resuming someone
//     else's conversation.

import { execFileSync } from "node:child_process";
import nodePath from "node:path";
import { homedir } from "node:os";
import type { TmuxAdapter } from "./tmux.js";
import { opencodeSeatPaths } from "./opencode-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

/** The input placeholder opencode's TUI shows when idle and accepting a prompt. */
export const OPENCODE_INTERACTIVE_READY_TEXT = "Ask anything";

export type OpencodeMode = "interactive" | "headless";

/** What an interactive launch records so the session id can be found later. */
export interface OpencodeInteractiveState {
  mode: "interactive";
  launchedAtMs: number;
  /** The seat's working directory, matched against session_v2.directory when deriving the id. */
  cwd?: string;
  /** Set when the seat was started on a known session (resume). */
  sessionId?: string;
}

export function opencodeInteractiveStatePath(stateRoot: string, sessionName: string): string {
  return nodePath.join(opencodeSeatPaths(stateRoot, sessionName).seatRoot, "interactive.json");
}

export function parseOpencodeInteractiveState(text: string): OpencodeInteractiveState | null {
  try {
    const v = JSON.parse(text) as Partial<OpencodeInteractiveState>;
    if (v?.mode !== "interactive" || typeof v.launchedAtMs !== "number") return null;
    return {
      mode: "interactive",
      launchedAtMs: v.launchedAtMs,
      ...(typeof v.cwd === "string" ? { cwd: v.cwd } : {}),
      ...(typeof v.sessionId === "string" ? { sessionId: v.sessionId } : {}),
    };
  } catch {
    return null;
  }
}

/** The opencode session id for a seat launched at `launchedAtMs` in `cwd`, or why there is none (yet). */
export function findOpencodeSession(
  state: OpencodeInteractiveState,
  dbPath: string,
): { ok: true; sessionId: string } | { ok: false; reason: "missing_sidecar" | "ambiguous" } {
  if (state.sessionId) return { ok: true, sessionId: state.sessionId };
  if (!state.cwd) return { ok: false, reason: "missing_sidecar" };
  let out: string;
  try {
    out = execFileSync(
      "sqlite3",
      [dbPath, `SELECT id FROM session_v2 WHERE time_created >= ${Math.floor(state.launchedAtMs) - 1000} AND directory = '${state.cwd.replace(/'/g, "''")}' ORDER BY time_created;`],
      { timeout: 5000, encoding: "utf8" },
    );
  } catch {
    return { ok: false, reason: "missing_sidecar" };
  }
  const fresh = out.split("\n").map((s) => s.trim()).filter(Boolean);
  if (fresh.length === 0) return { ok: false, reason: "missing_sidecar" };
  if (fresh.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, sessionId: fresh[0]! };
}

/** opencode's global session store. `OPENCODE_DB` overrides it for tests. */
export function defaultOpencodeSessionDb(): string {
  return process.env.OPENCODE_DB?.trim() || nodePath.join(homedir(), ".local/share/opencode/opencode.db");
}

export type OpencodePromptWait =
  | { ok: true }
  | { ok: false; kind: "shell" | "timeout"; evidence?: string };

/** Polls the pane until opencode's TUI shows its input placeholder (about 30s covers a cold start). */
export async function waitForOpencodePrompt(
  tmux: Pick<TmuxAdapter, "capturePaneContent" | "getPaneCommand">,
  sessionName: string,
  sleep: (ms: number) => Promise<void>,
): Promise<OpencodePromptWait> {
  const pollMs = 250;
  const attempts = 120;
  const shellGraceAttempts = 12;
  let atShellInARow = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pane = (await tmux.capturePaneContent(sessionName, 40)) ?? "";
    const evidence = pane.split("\n").slice(-12).join("\n");
    if (pane.includes(OPENCODE_INTERACTIVE_READY_TEXT)) return { ok: true };
    if (attempt >= shellGraceAttempts) {
      const paneCommand = ((await tmux.getPaneCommand(sessionName)) ?? "").replace(/^-/, "");
      atShellInARow = SHELL_COMMANDS.has(paneCommand) ? atShellInARow + 1 : 0;
      if (atShellInARow >= 2) return { ok: false, kind: "shell", evidence };
    }
    if (attempt < attempts - 1) await sleep(pollMs);
  }
  return { ok: false, kind: "timeout" };
}

/** The mode one seat runs in. A seat sets OPENCODE_SEAT_MODE (interactive|headless) in its own `env:`
 *  in the rig spec (OpenRig reserves OPENRIG_* names there, hence the different key), which lands in
 *  the seat's tmux session environment; an explicit `headless` there opts the seat out. Without a
 *  seat value the daemon's OPENRIG_OPENCODE_MODE decides, also honoring `headless` — an opencode
 *  seat is INTERACTIVE BY DEFAULT, and headless is the opt-in. */
export async function resolveOpencodeSeatMode(
  tmux: Partial<Pick<TmuxAdapter, "getSessionEnv">>,
  sessionName: string,
  daemonEnv: NodeJS.ProcessEnv = process.env,
): Promise<OpencodeMode> {
  try {
    const seatValue = await tmux.getSessionEnv?.(sessionName, "OPENCODE_SEAT_MODE");
    if (seatValue !== undefined && seatValue.trim() !== "") {
      return seatValue.trim().toLowerCase() === "headless" ? "headless" : "interactive";
    }
  } catch {
    /* an unreadable session environment falls back to the daemon's setting */
  }
  return daemonEnv.OPENRIG_OPENCODE_MODE?.trim().toLowerCase() === "headless" ? "headless" : "interactive";
}

/** The command typed into the seat's pane for an interactive seat: opencode's own TUI, no runner.
 *  The model is pinned through OPENCODE_MODEL (the TUI takes no `--model` flag); a resume continues
 *  an existing session id. No posture flag: the TUI shows its own permission prompts, wired to the
 *  operator's opencode config, which is the point of an interactive seat. */
export function buildOpencodeInteractiveCommand(opts: { model?: string; sessionId?: string }): string {
  const parts: string[] = [];
  if (opts.model?.trim()) parts.push(`OPENCODE_MODEL=${shellQuote(opts.model.trim())}`);
  parts.push("opencode");
  if (opts.sessionId) parts.push("--session", shellQuote(opts.sessionId));
  return parts.join(" ");
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
