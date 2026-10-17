import { describe, expect, it } from "vitest";
import {
  acpTextPrompt, buildOpencodeChildArgs, buildOpencodeChildEnv, buildOpencodePostureConfig, buildOpencodeRunnerCommand,
  buildPendingOpencodeRunnerState, encodeAcpError, encodeAcpNotification, encodeAcpRequest, encodeAcpResult,
  isOpencodeModelId, isOpencodeSessionId, opencodeSeatPaths, parseOpencodeRunnerState,
} from "../src/adapters/opencode-runner-protocol.js";

const SID = "ses_eb49b1749ffeC6daza8UI6Qof5";

describe("opencode runner protocol", () => {
  it("derives seat paths from the state root and session name", () => {
    expect(opencodeSeatPaths("/s/opencode", "orch@dev-team")).toEqual({
      seatRoot: "/s/opencode/orch@dev-team", runnerStatePath: "/s/opencode/orch@dev-team/runner-state.json",
    });
  });

  it("accepts only ses_ session ids", () => {
    expect(isOpencodeSessionId(SID)).toBe(true);
    for (const bad of ["", "ses_", "ses_short", `${SID}x y`, "--session", "../x", "c001e46a-af55-421e-82c0-def97b816b6b", 5, null, undefined]) {
      expect(isOpencodeSessionId(bad)).toBe(false);
    }
  });

  it("accepts provider/model ids and rejects flags, spaces and bare names", () => {
    for (const ok of ["opencode/glm-5.3-flash-free", "anthropic/claude-sonnet-4-5", "openrouter/z-ai/glm-4.6", "zai/glm-5.3:free"]) expect(isOpencodeModelId(ok)).toBe(true);
    for (const bad of ["glm", "--model", "a/b c", "a/;rm", "", "/x", 3, undefined]) expect(isOpencodeModelId(bad)).toBe(false);
  });

  it("parses sidecar state and rejects malformed records", () => {
    expect(parseOpencodeRunnerState(JSON.stringify({ ready: true, updatedAt: "t", sessionId: SID }))).toMatchObject({ ready: true });
    for (const bad of ["{", "[]", "null", JSON.stringify({ ready: "yes", updatedAt: "t" }), JSON.stringify({ ready: true })]) {
      expect(parseOpencodeRunnerState(bad)).toBeNull();
    }
  });

  it("builds a launch-scoped pending record that keeps the resume id visible", () => {
    expect(buildPendingOpencodeRunnerState("L", "t", null)).toEqual({ ready: false, launchId: "L", sessionId: undefined, updatedAt: "t" });
    expect(buildPendingOpencodeRunnerState("L", "t", { ready: true, updatedAt: "p", sessionId: "ses_old" }).sessionId).toBe("ses_old");
    expect(buildPendingOpencodeRunnerState("L", "t", null, SID).sessionId).toBe(SID);
  });

  it("runs `opencode acp` in the seat's cwd", () => {
    expect(buildOpencodeChildArgs({ cwd: "/w" })).toEqual(["acp", "--cwd", "/w"]);
  });

  describe("posture config", () => {
    it("asks for edits and commands on floor, commands only on auto, nothing on bypass", () => {
      expect(buildOpencodePostureConfig("floor")).toEqual({ permission: { edit: "ask", bash: "ask" } });
      expect(buildOpencodePostureConfig("auto")).toEqual({ permission: { edit: "allow", bash: "ask" } });
      expect(buildOpencodePostureConfig("full_bypass")).toBeNull();
    });
  });

  describe("buildOpencodeRunnerCommand", () => {
    const opts = { runnerEntryPath: "/d/opencode-runner.js", sessionName: "s@r", stateRoot: "/st", cwd: "/my proj", launchId: "L", posture: "floor" as const };
    it("quotes paths and includes the posture", () => {
      const cmd = buildOpencodeRunnerCommand(opts);
      expect(cmd.startsWith("node ")).toBe(true);
      expect(cmd).toContain("--posture floor");
      expect(cmd).toMatch(/--cwd '?"?\/my proj/);
    });
    it("adds optional flags only when set", () => {
      expect(buildOpencodeRunnerCommand(opts)).not.toContain("--session ");
      const full = buildOpencodeRunnerCommand({ ...opts, model: "opencode/glm-5.3-flash-free", sessionId: SID });
      expect(full).toContain("--model 'opencode/glm-5.3-flash-free'");
      expect(full).toContain(`--session '${SID}'`);
    });
  });

  describe("buildOpencodeChildEnv", () => {
    it("forwards only the baseline and OpenRig locators, never other credentials", () => {
      const env = buildOpencodeChildEnv({
        PATH: "/bin", HOME: "/home/u", XDG_DATA_HOME: "/xd", OPENRIG_URL: "http://x",
        OPENAI_API_KEY: "secret", GITHUB_TOKEN: "secret", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok",
      }, { sessionName: "s@r", posture: "full_bypass" });
      expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/u", XDG_DATA_HOME: "/xd", OPENRIG_URL: "http://x" });
      for (const name of ["OPENAI_API_KEY", "GITHUB_TOKEN", "OPENRIG_ACTIVITY_HOOK_TOKEN"]) expect(Object.keys(env)).not.toContain(name);
    });
    it("forwards exactly the provider variables the operator names", () => {
      const env = buildOpencodeChildEnv({
        OPENRIG_OPENCODE_ENV_PASSTHROUGH: "ZAI_API_KEY, bad-name,;rm", ZAI_API_KEY: "z", OPENAI_API_KEY: "o",
      }, { sessionName: "s@r", posture: "floor" });
      expect(env.ZAI_API_KEY).toBe("z");
      expect(Object.keys(env)).not.toContain("OPENAI_API_KEY");
    });
    it("keeps the real HOME so opencode's login survives, and pins seat identity", () => {
      const env = buildOpencodeChildEnv({ HOME: "/home/u", OPENRIG_NODE_ID: "stale", OPENRIG_SESSION_NAME: "stale" },
        { sessionName: "s@r", posture: "floor", nodeId: "n1", openrigHome: "/oh", openrigUrl: "http://d" });
      expect(env.HOME).toBe("/home/u");
      expect(env).toMatchObject({ OPENRIG_SESSION_NAME: "s@r", OPENRIG_RUNTIME: "opencode", OPENRIG_NODE_ID: "n1", OPENRIG_HOME: "/oh", OPENRIG_URL: "http://d" });
    });
    it("injects the posture as inline config, and an inherited config cannot loosen it", () => {
      const floor = buildOpencodeChildEnv({ OPENCODE_CONFIG_CONTENT: '{"permission":{"bash":"allow"}}' }, { sessionName: "s", posture: "floor" });
      expect(JSON.parse(floor.OPENCODE_CONFIG_CONTENT!)).toEqual({ permission: { edit: "ask", bash: "ask" } });
      const bypass = buildOpencodeChildEnv({ OPENCODE_CONFIG_CONTENT: '{"permission":{"bash":"deny"}}' }, { sessionName: "s", posture: "full_bypass" });
      expect(bypass.OPENCODE_CONFIG_CONTENT).toBeUndefined();
    });
  });

  describe("ACP encoding", () => {
    it("encodes each message kind as one NDJSON line", () => {
      expect(JSON.parse(encodeAcpRequest(3, "session/prompt", { a: 1 }))).toEqual({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { a: 1 } });
      expect(JSON.parse(encodeAcpNotification("session/cancel", { sessionId: SID }))).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: SID } });
      expect(JSON.parse(encodeAcpResult(0, { ok: true }))).toEqual({ jsonrpc: "2.0", id: 0, result: { ok: true } });
      expect(JSON.parse(encodeAcpError("x", -32601, "no"))).toEqual({ jsonrpc: "2.0", id: "x", error: { code: -32601, message: "no" } });
    });
    it("keeps multi-line prompts on a single line", () => {
      const line = encodeAcpRequest(1, "session/prompt", { prompt: acpTextPrompt("a\nb \"q\"") });
      expect(line.endsWith("\n")).toBe(true);
      expect(line.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(line).params.prompt).toEqual([{ type: "text", text: "a\nb \"q\"" }]);
    });
  });
});
