// The places a new runtime must be taught about besides its adapter: resume-token
// validation, adoption-time token capture, permission-drift observation, runtime
// fingerprinting and the daemon's adapter registry.
import { describe, expect, it } from "vitest";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";
import { resumeTypeForRuntime, validateResumeToken } from "../src/domain/resume-token-validation.js";
import { diagnoseRuntimePosture, observeOpencodePermission } from "../src/domain/permission-drift.js";

const SID = "ses_eb49b1749ffeC6daza8UI6Qof5";
const SESSION = "orch@dev-team";

describe("opencode resume-token validation", () => {
  it("maps the opencode runtime to the session token type", () => {
    expect(resumeTypeForRuntime("opencode")).toBe("opencode_session_id");
  });
  it("accepts a session id, trimming whitespace", () => {
    expect(validateResumeToken("opencode", `  ${SID}\n`)).toEqual({ ok: true, resumeType: "opencode_session_id", token: SID });
  });
  it.each([
    ["a flag", "--dangerously-skip-permissions"],
    ["a path", "/home/u/.local/share/opencode/x"],
    ["an agy conversation id", "c001e46a-af55-421e-82c0-def97b816b6b"],
    ["a session id with a suffix", `${SID} --x`],
  ])("rejects %s without echoing it", (_label, token) => {
    const result = validateResumeToken("opencode", token);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).not.toContain(token);
  });
  it("rejects a bare prefix, empty and non-string tokens, and an opencode token for another runtime's slot", () => {
    expect(validateResumeToken("opencode", "ses_")).toMatchObject({ ok: false });
    expect(validateResumeToken("opencode", "  ")).toMatchObject({ ok: false });
    expect(validateResumeToken("opencode", 42)).toMatchObject({ ok: false });
    expect(validateResumeToken("agy", SID)).toMatchObject({ ok: false });
  });
  it("lists opencode among the runtimes with resume tokens", () => {
    expect((validateResumeToken("terminal", SID) as { error: string }).error).toContain("opencode");
  });
});

describe("opencode adoption resume-token capture", () => {
  it("reads the opencode sidecar and never another runtime's", async () => {
    const result = await deriveResumeToken(
      { runtime: "opencode", sessionName: SESSION },
      {
        opencodeRunnerStateStore: { readSessionFile: (name) => { expect(name).toBe(SESSION); return { ok: true, sessionFile: SID }; } },
        agyRunnerStateStore: { readSessionFile: () => { throw new Error("agy sidecar must not be read"); } },
        piRunnerStateStore: { readSessionFile: () => { throw new Error("Pi sidecar must not be read"); } },
      },
    );
    expect(result).toEqual({ outcome: "captured", resumeType: "opencode_session_id", token: SID });
  });
  it("is a silent no-op when the opencode store is not wired", async () => {
    expect(await deriveResumeToken({ runtime: "opencode", sessionName: SESSION }, {})).toEqual({ outcome: "noop" });
  });
  it("skips with the sidecar's reason when there is no usable sidecar", async () => {
    expect(await deriveResumeToken({ runtime: "opencode", sessionName: SESSION }, { opencodeRunnerStateStore: { readSessionFile: () => ({ ok: false, reason: "missing_sidecar" }) } }))
      .toEqual({ outcome: "skipped", reason: "missing_sidecar" });
    expect(await deriveResumeToken({ runtime: "opencode", sessionName: SESSION }, { opencodeRunnerStateStore: { readSessionFile: () => ({ ok: false, reason: "parse_error" }) } }))
      .toEqual({ outcome: "skipped", reason: "parse_error" });
  });
  it("refuses a malformed session id instead of persisting it", async () => {
    const result = await deriveResumeToken({ runtime: "opencode", sessionName: SESSION }, { opencodeRunnerStateStore: { readSessionFile: () => ({ ok: true, sessionFile: "nope" }) } });
    expect(result).toEqual({ outcome: "skipped", reason: "invalid_token" });
  });
});

describe("opencode permission observation", () => {
  it("records the posture opencode actually launches with", () => {
    expect(observeOpencodePermission("floor")).toMatchObject({ runtime: "opencode", axis: "permission", state: "observed", value: "request-review" });
    expect(observeOpencodePermission("auto")).toMatchObject({ value: "auto" });
    expect(observeOpencodePermission("full_bypass")).toMatchObject({ value: "bypass" });
  });
  const fs = { cwdReadable: () => true as boolean | null } as never;
  it("diagnoses an opencode seat from the launch record (aligned on the permission axis)", () => {
    const diagnostic = diagnoseRuntimePosture({ runtime: "opencode", cwd: "/work", applied: observeOpencodePermission("floor"), fs });
    expect(diagnostic.enforcement).toMatchObject({ axis: "permission", state: "aligned", expected: "request-review" });
  });
  it("reports unknown, not aligned, when there is no launch record or another runtime's record", () => {
    expect(diagnoseRuntimePosture({ runtime: "opencode", cwd: "/work", applied: null, fs }).enforcement.state).not.toBe("aligned");
    expect(diagnoseRuntimePosture({ runtime: "opencode", cwd: "/work", applied: { runtime: "agy", axis: "permission", state: "observed", value: "bypass" }, fs }).enforcement.state).not.toBe("aligned");
  });
});
