// The places a new runtime must be taught about besides its adapter: resume-token
// validation, adoption-time token capture, and permission-drift observation.
import { describe, expect, it } from "vitest";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";
import { resumeTypeForRuntime, validateResumeToken } from "../src/domain/resume-token-validation.js";
import { diagnoseRuntimePosture, observeAgyPermission } from "../src/domain/permission-drift.js";

const CONV = "c001e46a-af55-421e-82c0-def97b816b6b";
const SESSION = "dev-qa@dev-team";

describe("agy resume-token validation", () => {
  it("maps the agy runtime to the conversation token type", () => {
    expect(resumeTypeForRuntime("agy")).toBe("agy_conversation_id");
  });
  it("accepts a conversation UUID, trimming whitespace and keeping case", () => {
    expect(validateResumeToken("agy", `  ${CONV}\n`)).toEqual({ ok: true, resumeType: "agy_conversation_id", token: CONV });
    expect(validateResumeToken("agy", CONV.toUpperCase())).toMatchObject({ ok: true, token: CONV.toUpperCase() });
  });
  it.each([
    ["a flag", "--dangerously-skip-permissions"],
    ["a path", "/home/u/.gemini/antigravity-cli/conversations/x.pb"],
    ["a Pi session file", "/openrig/state/pi/s/sessions/a.jsonl"],
    ["a UUID with a suffix", `${CONV}-extra`],
    ["a short id", "c001e46a"],
  ])("rejects %s without echoing it", (_label, token) => {
    const result = validateResumeToken("agy", token);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).not.toContain(token);
  });
  it("rejects empty and non-string tokens", () => {
    expect(validateResumeToken("agy", "  ")).toMatchObject({ ok: false });
    expect(validateResumeToken("agy", 42)).toMatchObject({ ok: false });
  });
  it("lists agy among the runtimes with resume tokens", () => {
    const err = validateResumeToken("terminal", CONV) as { ok: false; error: string };
    expect(err.error).toContain("agy");
  });
});

describe("agy adoption resume-token capture", () => {
  it("reads the agy sidecar and never the Pi or OMP ones", async () => {
    const result = await deriveResumeToken(
      { runtime: "agy", sessionName: SESSION },
      {
        agyRunnerStateStore: { readSessionFile: (name) => { expect(name).toBe(SESSION); return { ok: true, sessionFile: CONV }; } },
        piRunnerStateStore: { readSessionFile: () => { throw new Error("Pi sidecar must not be read"); } },
        ompRunnerStateStore: { readSessionFile: () => { throw new Error("OMP sidecar must not be read"); } },
      },
    );
    expect(result).toEqual({ outcome: "captured", resumeType: "agy_conversation_id", token: CONV });
  });
  it("is a silent no-op when the agy store is not wired", async () => {
    expect(await deriveResumeToken({ runtime: "agy", sessionName: SESSION }, {})).toEqual({ outcome: "noop" });
  });
  it("skips with the sidecar's reason when there is no usable sidecar", async () => {
    const missing = await deriveResumeToken({ runtime: "agy", sessionName: SESSION }, { agyRunnerStateStore: { readSessionFile: () => ({ ok: false, reason: "missing_sidecar" }) } });
    expect(missing).toEqual({ outcome: "skipped", reason: "missing_sidecar" });
    const broken = await deriveResumeToken({ runtime: "agy", sessionName: SESSION }, { agyRunnerStateStore: { readSessionFile: () => ({ ok: false, reason: "parse_error" }) } });
    expect(broken).toEqual({ outcome: "skipped", reason: "parse_error" });
  });
  it("refuses a malformed conversation id instead of persisting it", async () => {
    const result = await deriveResumeToken({ runtime: "agy", sessionName: SESSION }, { agyRunnerStateStore: { readSessionFile: () => ({ ok: true, sessionFile: "not-a-uuid" }) } });
    expect(result).toEqual({ outcome: "skipped", reason: "invalid_token" });
  });
});

describe("agy permission observation", () => {
  it("records the posture agy actually launches with", () => {
    expect(observeAgyPermission("floor")).toMatchObject({ runtime: "agy", axis: "permission", state: "observed", value: "request-review" });
    expect(observeAgyPermission("auto")).toMatchObject({ value: "auto" });
    expect(observeAgyPermission("full_bypass")).toMatchObject({ value: "bypass" });
  });
  const fs = { cwdReadable: () => true as boolean | null } as never;
  it("diagnoses an agy seat from the launch record (aligned on the permission axis)", () => {
    const diagnostic = diagnoseRuntimePosture({ runtime: "agy", cwd: "/work", applied: observeAgyPermission("floor"), fs });
    expect(diagnostic.enforcement).toMatchObject({ axis: "permission", state: "aligned", expected: "request-review" });
  });
  it("reports unknown, not aligned, when there is no launch record", () => {
    const diagnostic = diagnoseRuntimePosture({ runtime: "agy", cwd: "/work", applied: null, fs });
    expect(diagnostic.enforcement.state).not.toBe("aligned");
  });
  it("does not accept another runtime's observation for an agy seat", () => {
    const diagnostic = diagnoseRuntimePosture({ runtime: "agy", cwd: "/work", applied: { runtime: "omp", axis: "permission", state: "observed", value: "yolo" }, fs });
    expect(diagnostic.enforcement.state).not.toBe("aligned");
  });
});
