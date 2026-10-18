// Interactive agy seats (OPENRIG_AGY_MODE=interactive): agy's own console runs in the pane, with no
// runner and so no sidecar naming the conversation. This file holds the two pieces that replace it:
//   - waiting for the console's prompt (shared by launch and resume), and
//   - finding the conversation id. agy writes ~/.gemini/antigravity-cli/conversations/<id>.db at the
//     seat's first turn, so the id is the db that appeared after the seat launched. If more than one
//     appeared (two seats took their first turn in the same window) the seat cannot tell which is its
//     own, so it reports none rather than risk resuming someone else's conversation.

import fs from "node:fs";
import nodePath from "node:path";
import type { TmuxAdapter } from "./tmux.js";
import { AGY_INTERACTIVE_READY_TEXT, AGY_INTERACTIVE_TRUST_TEXT, agySeatPaths } from "./agy-runner-protocol.js";

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);
const CONVERSATION_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.db$/;

export interface AgyConversationFile {
  name: string;
  /** Creation time, falling back to modification time where the filesystem has no birth time. */
  createdMs: number;
}

export interface AgyConversationStore {
  dir: string;
  list(dir: string): AgyConversationFile[];
}

export function defaultAgyConversationStore(home = process.env.HOME ?? ""): AgyConversationStore {
  return {
    dir: nodePath.join(home, ".gemini", "antigravity-cli", "conversations"),
    list: (dir) => {
      try {
        return fs.readdirSync(dir).flatMap((name) => {
          try {
            const st = fs.statSync(nodePath.join(dir, name));
            return [{ name, createdMs: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs }];
          } catch { return []; }
        });
      } catch { return []; }
    },
  };
}

/** What an interactive launch records so the conversation id can be found later. */
export interface AgyInteractiveState {
  mode: "interactive";
  launchedAtMs: number;
  /** Set when the seat was started on a known conversation (resume). */
  conversationId?: string;
}

export function agyInteractiveStatePath(stateRoot: string, sessionName: string): string {
  return nodePath.join(agySeatPaths(stateRoot, sessionName).seatRoot, "interactive.json");
}

export function parseAgyInteractiveState(text: string): AgyInteractiveState | null {
  try {
    const v = JSON.parse(text) as Partial<AgyInteractiveState>;
    if (v?.mode !== "interactive" || typeof v.launchedAtMs !== "number") return null;
    return { mode: "interactive", launchedAtMs: v.launchedAtMs, ...(typeof v.conversationId === "string" ? { conversationId: v.conversationId } : {}) };
  } catch { return null; }
}

/** The conversation id for a seat launched at `launchedAtMs`, or why there is none (yet). */
export function findAgyConversation(
  state: AgyInteractiveState,
  store: AgyConversationStore,
): { ok: true; conversationId: string } | { ok: false; reason: "missing_sidecar" | "ambiguous" } {
  if (state.conversationId) return { ok: true, conversationId: state.conversationId };
  // Clock slack: file times and the daemon clock come from the same host, so a second is plenty.
  const fresh = store.list(store.dir)
    .flatMap((f) => { const m = CONVERSATION_FILE.exec(f.name); return m && f.createdMs >= state.launchedAtMs - 1000 ? [m[1]!] : []; });
  if (fresh.length === 0) return { ok: false, reason: "missing_sidecar" };
  if (fresh.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, conversationId: fresh[0]! };
}

export type AgyPromptWait =
  | { ok: true }
  | { ok: false; kind: "trust" | "shell" | "timeout"; evidence?: string };

/** Polls the pane until agy shows its input hint (about 30s covers a cold start). */
export async function waitForAgyPrompt(
  tmux: Pick<TmuxAdapter, "capturePaneContent" | "getPaneCommand">,
  sessionName: string,
  sleep: (ms: number) => Promise<void>,
): Promise<AgyPromptWait> {
  const pollMs = 250;
  const attempts = 120;
  const shellGraceAttempts = 12;
  let atShellInARow = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pane = (await tmux.capturePaneContent(sessionName, 40)) ?? "";
    const evidence = pane.split("\n").slice(-12).join("\n");
    if (pane.includes(AGY_INTERACTIVE_TRUST_TEXT)) return { ok: false, kind: "trust", evidence };
    if (pane.includes(AGY_INTERACTIVE_READY_TEXT)) return { ok: true };
    if (attempt >= shellGraceAttempts) {
      const paneCommand = ((await tmux.getPaneCommand(sessionName)) ?? "").replace(/^-/, "");
      atShellInARow = SHELL_COMMANDS.has(paneCommand) ? atShellInARow + 1 : 0;
      if (atShellInARow >= 2) return { ok: false, kind: "shell", evidence };
    }
    if (attempt < attempts - 1) await sleep(pollMs);
  }
  return { ok: false, kind: "timeout" };
}
