import { describe, expect, it, vi } from "vitest";
import { AgyInteractiveTokenService } from "../src/domain/agy-interactive-token-service.js";

const CONV = "c001e46a-af55-421e-82c0-def97b816b6b";
const dbWith = (rows: Array<{ id: string; session_name: string }>) => ({ prepare: () => ({ all: () => rows }) }) as never;

describe("AgyInteractiveTokenService", () => {
  it("gives a running seat with no token the conversation the adapter names", () => {
    const recordResumeAttempt = vi.fn(() => true);
    const svc = new AgyInteractiveTokenService({
      db: dbWith([{ id: "s1", session_name: "r1@rig" }]),
      sessionRegistry: { recordResumeAttempt },
      reader: { readSessionFile: (n) => (n === "r1@rig" ? { ok: true, sessionFile: CONV } : { ok: false, reason: "x" }) },
    });
    expect(svc.sweep()).toBe(1);
    expect(recordResumeAttempt).toHaveBeenCalledWith("s1", "agy_conversation_id", CONV);
  });

  it("leaves the row alone while the id is missing or ambiguous, and survives a reader that throws", () => {
    const recordResumeAttempt = vi.fn(() => true);
    const reasons = ["missing_sidecar", "ambiguous"];
    let i = 0;
    const svc = new AgyInteractiveTokenService({
      db: dbWith([{ id: "a", session_name: "a@rig" }, { id: "b", session_name: "b@rig" }, { id: "c", session_name: "c@rig" }]),
      sessionRegistry: { recordResumeAttempt },
      reader: { readSessionFile: () => { if (i >= 2) throw new Error("boom"); return { ok: false, reason: reasons[i++]! }; } },
    });
    expect(svc.sweep()).toBe(0);
    expect(recordResumeAttempt).not.toHaveBeenCalled();
  });

  it("does not count a write the registry refused (a token landed another way)", () => {
    const svc = new AgyInteractiveTokenService({
      db: dbWith([{ id: "s1", session_name: "r1@rig" }]),
      sessionRegistry: { recordResumeAttempt: () => false },
      reader: { readSessionFile: () => ({ ok: true, sessionFile: CONV }) },
    });
    expect(svc.sweep()).toBe(0);
  });
});
