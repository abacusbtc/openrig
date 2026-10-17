import { describe, expect, it } from "vitest";
import {
  AgyRunnerCore, AGY_INIT_TIMEOUT_MS, AGY_MAX_QUEUED_TURNS, agyWorkspaceTrustNotice, deniedActionsNotice,
  mapAgyStepUpdate, parseAgyRunnerArgs, summarizeToolParams, type AgyRunnerIo,
} from "../src/adapters/agy-runner.js";
import type { AgyRunnerState } from "../src/adapters/agy-runner-protocol.js";

const CONV = "c001e46a-af55-421e-82c0-def97b816b6b";
const OTHER = "11111111-2222-4333-8444-555555555555";

function harness(opts: { resume?: string; posture?: "floor" | "auto" | "full_bypass" } = {}) {
  const sent: string[] = [];
  const mirror: string[] = [];
  const activity: Array<Record<string, unknown>> = [];
  const sidecars: AgyRunnerState[] = [];
  const signals: string[] = [];
  const spawns: Array<string | undefined> = [];
  let exitCode: number | undefined;
  let tick = 0;
  const io: AgyRunnerIo = {
    sendToChild: (l) => { sent.push(l); },
    signalChild: (s) => { signals.push(s); },
    spawnChild: (c) => { spawns.push(c); },
    mirrorLine: (l) => { mirror.push(`${l}\n`); },
    mirrorAppend: (t) => { mirror.push(t); },
    postActivity: (p) => { activity.push(p); },
    writeSidecar: (s) => { sidecars.push(s); },
    exit: (c) => { exitCode = c; },
    now: () => `2026-10-17T00:00:${String(tick++).padStart(2, "0")}Z`,
  };
  const core = new AgyRunnerCore(io, {
    sessionName: "dev-qa@dev-team", nodeId: "node-1", generation: "3", launchId: "L1", posture: opts.posture ?? "floor",
  }, opts.resume, 1000);
  const init = (id = CONV) => core.onChildLine(JSON.stringify({ event: "init", conversation_id: id, init: { tools: [] } }));
  const step = (s: Record<string, unknown>) => core.onChildLine(JSON.stringify({ event: "step_update", step_update: { conversation_id: CONV, ...s } }));
  const result = (r: Record<string, unknown>) => core.onChildLine(JSON.stringify({ event: "result", result: { conversation_id: CONV, status: "SUCCESS", response: "", ...r } }));
  const text = () => mirror.join("");
  const lastSidecar = () => sidecars[sidecars.length - 1]!;
  return { core, sent, mirror, activity, sidecars, signals, spawns, init, step, result, text, lastSidecar, get exitCode() { return exitCode; } };
}

describe("mapAgyStepUpdate", () => {
  it("appends streamed assistant text", () => {
    expect(mapAgyStepUpdate({ step_type: "agent_response", state: "ACTIVE", text_delta: "pong" })).toEqual({ mirrorLines: [], mirrorAppend: "pong" });
  });
  it("ignores empty deltas, user_input and unknown steps", () => {
    expect(mapAgyStepUpdate({ step_type: "agent_response", state: "DONE" })).toEqual({ mirrorLines: [] });
    expect(mapAgyStepUpdate({ step_type: "user_input", state: "DONE" })).toEqual({ mirrorLines: [] });
    expect(mapAgyStepUpdate({ step_type: "system_message", state: "DONE" })).toEqual({ mirrorLines: [] });
    expect(mapAgyStepUpdate({ step_type: "brand_new", state: "ACTIVE" })).toEqual({ mirrorLines: [] });
  });
  it("shows a tool start with a one-line argument summary and posts PreToolUse", () => {
    const mapped = mapAgyStepUpdate({ step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: { parameters: { CommandLine: "echo hi > out.txt" } } });
    expect(mapped.mirrorLines).toEqual(["  ⚙ run_command echo hi > out.txt …"]);
    expect(mapped.activity).toEqual({ hookEvent: "PreToolUse", subtype: "run_command" });
    expect(mapped.closesLine).toBe(true);
  });
  it("marks tool completion and failure", () => {
    expect(mapAgyStepUpdate({ step_type: "tool", state: "DONE", tool_name: "view_file" }).mirrorLines).toEqual(["  ⚙ view_file done"]);
    expect(mapAgyStepUpdate({ step_type: "tool", state: "ERROR", tool_name: "view_file" }).mirrorLines).toEqual(["  ⚙ view_file FAILED"]);
    expect(mapAgyStepUpdate({ step_type: "tool", state: "CANCELLED", tool_name: "view_file" }).mirrorLines).toEqual(["  ⚙ view_file cancelled"]);
  });
});

describe("summarizeToolParams", () => {
  it("prefers known argument keys, collapses whitespace and caps length", () => {
    expect(summarizeToolParams({ CommandLine: "a\n  b   c" })).toBe("a b c");
    expect(summarizeToolParams({ Other: "x", AbsolutePath: "/p" })).toBe("/p");
    expect(summarizeToolParams({ n: 1 })).toBe("");
    expect(summarizeToolParams(null)).toBe("");
    expect(summarizeToolParams({ CommandLine: "x".repeat(300) }).length).toBe(100);
  });
});

describe("AgyRunnerCore lifecycle", () => {
  it("spawns on start, resuming the requested conversation", () => {
    const h = harness({ resume: CONV });
    h.core.start();
    expect(h.spawns).toEqual([CONV]);
    expect(h.core.phase).toBe("starting");
  });

  it("becomes ready on init: sidecar, READY marker and session identity", () => {
    const h = harness();
    h.core.start();
    h.init();
    expect(h.core.phase).toBe("idle");
    expect(h.lastSidecar()).toMatchObject({ ready: true, launchId: "L1", conversationId: CONV, busy: false });
    expect(h.text()).toContain(`[agy-runner] READY conversation ${CONV}`);
    expect(h.activity).toContainEqual(expect.objectContaining({
      eventFamily: "session_identity", runtime: "agy", sessionName: "dev-qa@dev-team", sessionId: CONV, hookEvent: "SessionStart", generation: "3", nodeId: "node-1",
    }));
  });

  it("rejects an init without a valid conversation id", () => {
    const h = harness();
    h.core.start();
    h.core.onChildLine(JSON.stringify({ event: "init", conversation_id: "not-a-uuid" }));
    expect(h.core.phase).toBe("exited");
    expect(h.exitCode).toBe(1);
    expect(h.lastSidecar().ready).toBe(false);
  });

  it("fails when a resume comes up on a different conversation", () => {
    const h = harness({ resume: CONV });
    h.core.start();
    h.init(OTHER);
    expect(h.core.phase).toBe("exited");
    expect(h.signals).toContain("SIGTERM");
    expect(h.text()).toContain(`${OTHER} but ${CONV} was requested`);
    expect(h.lastSidecar().exited).toBeDefined();
  });

  it("times out when init never arrives", () => {
    const h = harness();
    h.core.start();
    h.core.onTick(1000 + AGY_INIT_TIMEOUT_MS - 1);
    expect(h.core.phase).toBe("starting");
    h.core.onTick(1000 + AGY_INIT_TIMEOUT_MS + 1);
    expect(h.core.phase).toBe("exited");
    expect(h.exitCode).toBe(1);
    expect(h.text()).toContain("did not report init");
  });
});

describe("AgyRunnerCore turns", () => {
  it("holds input until ready, then sends it as a stream-json user turn", () => {
    const h = harness();
    h.core.start();
    h.core.onPaneInput("hello agy");
    expect(h.sent).toEqual([]);
    h.init();
    expect(h.sent).toEqual([`${JSON.stringify({ event: "user", message: { content: "hello agy" } })}\n`]);
    expect(h.core.phase).toBe("busy");
    expect(h.lastSidecar().busy).toBe(true);
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "active", subtype: "turn_start", runtime: "agy" }));
  });

  it("streams text, tools and denials to the pane and reports Stop on result", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.onPaneInput("run it");
    h.step({ step_type: "tool", state: "ACTIVE", tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls" } } });
    h.step({ step_type: "tool", state: "DONE", tool_name: "run_command" });
    h.step({ step_type: "agent_response", state: "ACTIVE", text_delta: "done" });
    h.result({ response: "done", denied_actions: [{ action: "command", display_name: "rm -rf x" }] });
    const text = h.text();
    expect(text).toContain("⚙ run_command ls …");
    expect(text).toContain("⚙ run_command done");
    expect(text).toContain("done\n");
    expect(text).toContain("denied command: rm -rf x");
    expect(text).toContain("permissions.allow");
    expect(h.core.phase).toBe("idle");
    expect(h.lastSidecar()).toMatchObject({ busy: false, ready: true });
    expect(h.lastSidecar().lastTurnAt).toBeDefined();
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "PreToolUse", subtype: "run_command" }));
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "Stop", subtype: "turn_end" }));
  });

  it("terminates a streamed line before printing the next tool line", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.onPaneInput("x");
    h.step({ step_type: "agent_response", state: "ACTIVE", text_delta: "thinking aloud" });
    h.step({ step_type: "tool", state: "ACTIVE", tool_name: "view_file" });
    expect(h.text()).toContain("thinking aloud\n  ⚙ view_file");
  });

  it("prints the final response when the turn never streamed text", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.onPaneInput("x");
    h.result({ response: "the whole answer\n" });
    expect(h.text()).toContain("the whole answer");
  });

  it("does not repeat streamed text from the final response", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.onPaneInput("x");
    h.step({ step_type: "agent_response", state: "ACTIVE", text_delta: "pong" });
    h.result({ response: "pong\n" });
    expect(h.text().match(/pong/g)).toHaveLength(1);
  });

  it("serialises queued messages: one turn at a time, in order", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.onPaneInput("first");
    h.core.onPaneInput("second");
    h.core.onPaneInput("third");
    expect(h.sent).toHaveLength(1);
    expect(h.core.queued).toBe(2);
    expect(h.text()).toContain("queued (2 waiting)");
    h.result({});
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toContain("second");
    h.result({});
    expect(h.sent[2]).toContain("third");
    h.result({});
    expect(h.core.phase).toBe("idle");
    expect(h.core.queued).toBe(0);
  });

  it("drops messages beyond the queue cap with a visible error", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.onPaneInput("busy");
    for (let i = 0; i < AGY_MAX_QUEUED_TURNS; i++) h.core.onPaneInput(`m${i}`);
    h.core.onPaneInput("overflow");
    expect(h.core.queued).toBe(AGY_MAX_QUEUED_TURNS);
    expect(h.text()).toContain("input queue is full");
  });

  it("surfaces a failed turn but keeps the seat alive for the next one", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.onPaneInput("x");
    h.result({ status: "ERROR", error: "quota exceeded" });
    expect(h.text()).toContain("ERROR turn failed: quota exceeded");
    expect(h.core.phase).toBe("idle");
    expect(h.exitCode).toBeUndefined();
  });

  it("treats a result with no turn in flight as a diagnostic, not a turn outcome", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.result({ status: "ERROR", error: "stream input cancelled: context canceled" });
    expect(h.text()).toContain("[agy] stream input cancelled");
    expect(h.text()).not.toContain("turn failed");
    expect(h.activity.filter((a) => a.hookEvent === "Stop")).toHaveLength(0);
    expect(h.core.phase).toBe("idle");
  });

  it("ignores everything agy says after the runner has exited", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.shutdown("stop");
    const before = h.mirror.length;
    h.result({ status: "ERROR", error: "late" });
    h.core.onChildLine("error: late diagnostic");
    expect(h.mirror.length).toBe(before);
  });

  it("mirrors plain diagnostics from agy as-is", () => {
    const h = harness();
    h.core.start();
    h.core.onChildLine("warning: ignoring unsupported stream input message event \"x\"");
    expect(h.text()).toContain("[agy] warning: ignoring unsupported");
  });

  it("ignores blank and ANSI-only lines", () => {
    const h = harness();
    h.core.start();
    h.core.onChildLine("");
    h.core.onChildLine("\u001b[0m");
    expect(h.mirror).toEqual([]);
  });

  it("does not leak ignored input after exit", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.onChildExit(1);
    h.core.onPaneInput("late");
    expect(h.sent).toEqual([]);
  });
});

describe("AgyRunnerCore interrupt", () => {
  it("SIGINTs a busy turn, then respawns on the same conversation and resumes the queue", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.onPaneInput("long task");
    h.core.onPaneInput("after");
    h.core.onPaneInput("/abort");
    expect(h.signals).toEqual(["SIGINT"]);
    expect(h.core.phase).toBe("interrupting");
    // agy's own result for the interrupted turn must not count as a normal completion.
    h.result({ status: "ERROR", error: "interrupted" });
    expect(h.activity.filter((a) => a.subtype === "turn_end")).toHaveLength(0);
    h.core.onChildExit(1);
    expect(h.spawns).toEqual([undefined, CONV]);
    expect(h.core.phase).toBe("starting");
    expect(h.exitCode).toBeUndefined();
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "Stop", subtype: "interrupted" }));
    h.init();
    expect(h.text()).toContain(`agy restarted on conversation ${CONV}`);
    expect(h.sent.at(-1)).toContain("after");
  });

  it("does nothing when idle, starting or already interrupting", () => {
    const h = harness();
    h.core.start();
    h.core.onPaneInput("/abort");
    expect(h.text()).toContain("still starting");
    h.init();
    h.core.onPaneInput("/abort");
    expect(h.text()).toContain("nothing to interrupt");
    expect(h.signals).toEqual([]);
    h.core.onPaneInput("work");
    h.core.onPaneInput("/abort");
    h.core.onPaneInput("/abort");
    expect(h.signals).toEqual(["SIGINT"]);
    expect(h.text()).toContain("already interrupting");
  });
});

describe("AgyRunnerCore exit", () => {
  it("records an unexpected agy exit honestly", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.onPaneInput("x");
    h.core.onChildExit(137);
    expect(h.core.phase).toBe("exited");
    expect(h.exitCode).toBe(1);
    expect(h.lastSidecar()).toMatchObject({ ready: false, exited: { code: 137 } });
    expect(h.text()).toContain("[agy-runner] ERROR agy exited with code 137");
    expect(h.text()).toContain("[agy-runner] EXITED");
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "Stop", subtype: "agy_exited" }));
  });

  it("a requested shutdown stops the child and exits cleanly", () => {
    const h = harness();
    h.core.start();
    h.init();
    h.core.shutdown("runner received SIGTERM");
    expect(h.signals).toContain("SIGTERM");
    expect(h.exitCode).toBe(0);
    expect(h.lastSidecar().exited).toBeDefined();
    // The child's own close event afterwards is a no-op.
    h.core.onChildExit(143);
    expect(h.exitCode).toBe(0);
  });
});

describe("deniedActionsNotice", () => {
  it("is empty without denials", () => {
    expect(deniedActionsNotice([], "floor")).toEqual([]);
  });
  it("caps the list and points at the fix for a floor posture", () => {
    const denied = Array.from({ length: 7 }, (_, i) => ({ action: "command", display_name: `c${i}` }));
    const lines = deniedActionsNotice(denied, "floor");
    expect(lines.filter((l) => l.includes("denied command"))).toHaveLength(5);
    expect(lines.join("\n")).toContain("and 2 more denied");
    expect(lines.at(-1)).toContain("permissions.allow");
  });
  it("says so when a bypassed seat is still denied", () => {
    expect(deniedActionsNotice([{ action: "command" }], "full_bypass").at(-1)).toContain("bypassed yet agy still denied");
  });
});

describe("agyWorkspaceTrustNotice", () => {
  const settings = JSON.stringify({ trustedWorkspaces: ["/home/u/projects", "/home/u/.hermes"] });
  it("is silent for a trusted workspace or a subdirectory", () => {
    expect(agyWorkspaceTrustNotice(settings, "/home/u/projects")).toBeUndefined();
    expect(agyWorkspaceTrustNotice(settings, "/home/u/projects/openrig/packages")).toBeUndefined();
  });
  it("warns for an untrusted workspace, including a sibling with a shared prefix", () => {
    expect(agyWorkspaceTrustNotice(settings, "/tmp/x")).toContain("not in agy's trustedWorkspaces");
    expect(agyWorkspaceTrustNotice(settings, "/home/u/projects-old")).toContain("not in agy's trustedWorkspaces");
  });
  it("is silent when settings are absent or unreadable", () => {
    expect(agyWorkspaceTrustNotice(null, "/tmp/x")).toBeUndefined();
    expect(agyWorkspaceTrustNotice("{nope", "/tmp/x")).toBeUndefined();
    expect(agyWorkspaceTrustNotice("{}", "/tmp/x")).toBeUndefined();
  });
});

describe("parseAgyRunnerArgs", () => {
  const base = ["--session-name", "s", "--state-root", "/st", "--cwd", "/w", "--launch-id", "L", "--posture", "floor"];
  it("parses a full command line", () => {
    expect(parseAgyRunnerArgs([...base, "--model", "Gemini 3.8 Flash (Medium)", "--effort", "high", "--conversation", CONV])).toEqual({
      sessionName: "s", stateRoot: "/st", cwd: "/w", launchId: "L", posture: "floor", model: "Gemini 3.8 Flash (Medium)", effort: "high", conversationId: CONV,
    });
  });
  it.each([
    [["--posture", "floor"], "--session-name is required"],
    [[...base, "--bogus"], "unknown flag: --bogus"],
    [[...base.slice(0, -2)], "--posture is required"],
    [[...base.slice(0, -1), "yolo"], "unsupported posture: yolo"],
    [[...base, "--effort", "extreme"], "unsupported effort"],
    [[...base, "--conversation", "../../etc/passwd"], "--conversation must be a conversation id"],
    [[...base, "--model"], "--model requires a value"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseAgyRunnerArgs(argv as string[])).toThrow(message as string);
  });
  it("requires a launch id", () => {
    expect(() => parseAgyRunnerArgs(["--session-name", "s", "--state-root", "/st", "--cwd", "/w", "--posture", "auto"])).toThrow("--launch-id is required");
  });
});

