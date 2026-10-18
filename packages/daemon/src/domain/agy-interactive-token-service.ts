// Interactive agy seats (OPENRIG_AGY_MODE=interactive) have no conversation id at launch: agy creates it
// at the seat's first turn. This service fills an empty resume token for running agy seats once the
// adapter can name the conversation, so snapshots and restores have something to resume. It only fills
// an empty row (recordResumeAttempt), so a token written any other way always wins, and an ambiguous or
// missing conversation leaves the row empty.

import type Database from "better-sqlite3";
import type { SessionRegistry } from "./session-registry.js";

export const DEFAULT_AGY_TOKEN_POLL_INTERVAL_MS = 15_000;

export interface AgyConversationReader {
  readSessionFile(sessionName: string): { ok: true; sessionFile: string } | { ok: false; reason: string };
}

export class AgyInteractiveTokenService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: {
      db: Database.Database;
      sessionRegistry: Pick<SessionRegistry, "recordResumeAttempt">;
      reader: AgyConversationReader;
      intervalMs?: number;
    },
  ) {}

  /** One pass; returns how many seats were given a token. */
  sweep(): number {
    const rows = this.deps.db.prepare(`
      SELECT s.id as id, s.session_name as session_name
      FROM nodes n
      JOIN sessions s ON s.node_id = n.id
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
      WHERE n.runtime = 'agy' AND s.status = 'running' AND s.session_name IS NOT NULL
        AND (s.resume_token IS NULL OR trim(s.resume_token) = '')
    `).all() as Array<{ id: string; session_name: string }>;
    let filled = 0;
    for (const row of rows) {
      let read: ReturnType<AgyConversationReader["readSessionFile"]>;
      try { read = this.deps.reader.readSessionFile(row.session_name); } catch { continue; }
      if (read.ok && this.deps.sessionRegistry.recordResumeAttempt(row.id, "agy_conversation_id", read.sessionFile)) filled++;
    }
    return filled;
  }

  start(): void {
    if (this.timer) return;
    const run = () => { try { this.sweep(); } catch { /* the next tick retries */ } };
    this.timer = setInterval(run, this.deps.intervalMs ?? DEFAULT_AGY_TOKEN_POLL_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
