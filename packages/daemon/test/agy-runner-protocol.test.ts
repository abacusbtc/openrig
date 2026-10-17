import { describe, expect, it } from "vitest";
import {
  agySeatPaths, buildAgyChildArgs, buildAgyChildEnv, buildAgyRunnerCommand, buildPendingAgyRunnerState,
  encodeAgyUserMessage, isAgyConversationId, parseAgyRunnerState,
} from "../src/adapters/agy-runner-protocol.js";

const CONV = "c001e46a-af55-421e-82c0-def97b816b6b";

describe("agy runner protocol", () => {
  it("derives seat paths from the state root and session name", () => {
    expect(agySeatPaths("/s/agy", "dev-qa@dev-team")).toEqual({
      seatRoot: "/s/agy/dev-qa@dev-team", runnerStatePath: "/s/agy/dev-qa@dev-team/runner-state.json",
    });
  });

  it("accepts only UUID conversation ids", () => {
    expect(isAgyConversationId(CONV)).toBe(true);
    expect(isAgyConversationId(CONV.toUpperCase())).toBe(true);
    for (const bad of ["", "abc", `${CONV}x`, "--dangerously-skip-permissions", "../x", 5, null, undefined]) {
      expect(isAgyConversationId(bad)).toBe(false);
    }
  });

  it("parses sidecar state and rejects malformed records", () => {
    expect(parseAgyRunnerState(JSON.stringify({ ready: true, updatedAt: "t", conversationId: CONV }))).toMatchObject({ ready: true });
    for (const bad of ["{", "[]", "null", JSON.stringify({ ready: "yes", updatedAt: "t" }), JSON.stringify({ ready: true })]) {
      expect(parseAgyRunnerState(bad)).toBeNull();
    }
  });

  it("builds a launch-scoped pending record that keeps the resume id visible", () => {
    expect(buildPendingAgyRunnerState("L", "t", null)).toEqual({ ready: false, launchId: "L", conversationId: undefined, updatedAt: "t" });
    expect(buildPendingAgyRunnerState("L", "t", { ready: true, updatedAt: "p", conversationId: "old" }).conversationId).toBe("old");
    expect(buildPendingAgyRunnerState("L", "t", null, CONV).conversationId).toBe(CONV);
  });

  describe("buildAgyChildArgs", () => {
    const base = ["--print=", "--input-format", "stream-json", "--output-format", "stream-json"];
    it("always uses the empty --print= and stream-json both ways", () => {
      expect(buildAgyChildArgs({ posture: "floor" })).toEqual(base);
    });
    it("maps postures: floor adds nothing, auto uses --mode auto, full_bypass skips permissions", () => {
      expect(buildAgyChildArgs({ posture: "auto" })).toEqual([...base, "--mode", "auto"]);
      expect(buildAgyChildArgs({ posture: "full_bypass" })).toEqual([...base, "--dangerously-skip-permissions"]);
    });
    it("passes model, effort and the resume conversation", () => {
      expect(buildAgyChildArgs({ posture: "floor", model: " Gemini 3.8 Flash (Medium) ", effort: "high", conversationId: CONV }))
        .toEqual([...base, "--model", "Gemini 3.8 Flash (Medium)", "--effort", "high", "--conversation", CONV]);
    });
    it("ignores blank model and effort", () => {
      expect(buildAgyChildArgs({ posture: "floor", model: "  ", effort: "" })).toEqual(base);
    });
  });

  describe("buildAgyRunnerCommand", () => {
    const opts = { runnerEntryPath: "/d/agy-runner.js", sessionName: "s@r", stateRoot: "/st", cwd: "/my proj", launchId: "L", posture: "floor" as const };
    it("quotes paths and includes the posture", () => {
      const cmd = buildAgyRunnerCommand(opts);
      expect(cmd.startsWith("node ")).toBe(true);
      expect(cmd).toContain("--posture floor");
      expect(cmd).toContain("--launch-id");
      expect(cmd).toMatch(/--cwd '?"?\/my proj/);
    });
    it("adds optional flags only when set", () => {
      expect(buildAgyRunnerCommand(opts)).not.toContain("--conversation");
      const full = buildAgyRunnerCommand({ ...opts, model: "m", effort: "low", conversationId: CONV });
      expect(full).toContain("--model");
      expect(full).toContain("--effort");
      expect(full).toContain(`--conversation '${CONV}'`);
    });
  });

  describe("buildAgyChildEnv", () => {
    it("forwards only the baseline and OpenRig locators, never other credentials", () => {
      const env = buildAgyChildEnv({
        PATH: "/bin", HOME: "/home/u", LANG: "C", OPENRIG_URL: "http://x", OPENRIG_PORT: "7433",
        OPENAI_API_KEY: "secret", GITHUB_TOKEN: "secret", ANTHROPIC_API_KEY: "secret", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok",
      }, { sessionName: "s@r" });
      expect(env).toMatchObject({ PATH: "/bin", HOME: "/home/u", LANG: "C", OPENRIG_URL: "http://x", OPENRIG_PORT: "7433" });
      expect(Object.keys(env)).not.toContain("OPENAI_API_KEY");
      expect(Object.keys(env)).not.toContain("GITHUB_TOKEN");
      expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
      expect(Object.keys(env)).not.toContain("OPENRIG_ACTIVITY_HOOK_TOKEN");
    });
    it("keeps the real HOME so agy's OAuth login survives, and pins seat identity", () => {
      const env = buildAgyChildEnv({ HOME: "/home/u", OPENRIG_NODE_ID: "stale", OPENRIG_SESSION_NAME: "stale" },
        { sessionName: "s@r", nodeId: "n1", openrigHome: "/oh", openrigUrl: "http://d" });
      expect(env.HOME).toBe("/home/u");
      expect(env).toMatchObject({ OPENRIG_SESSION_NAME: "s@r", OPENRIG_RUNTIME: "agy", OPENRIG_NODE_ID: "n1", OPENRIG_HOME: "/oh", OPENRIG_URL: "http://d" });
    });
  });

  it("encodes a user turn as one NDJSON line, escaping newlines", () => {
    const line = encodeAgyUserMessage("a\nb \"q\"");
    expect(line.endsWith("\n")).toBe(true);
    expect(line.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(line)).toEqual({ event: "user", message: { content: "a\nb \"q\"" } });
  });
});
