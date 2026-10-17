import { describe, expect, it } from "vitest";
import {
  OpencodeRunnerCore, OPENCODE_CANCEL_KILL_MS, OPENCODE_CANCEL_TERM_MS, OPENCODE_INIT_TIMEOUT_MS, OPENCODE_MAX_QUEUED_TURNS,
  OPENCODE_PERMISSION_TIMEOUT_MS, mapOpencodeUpdate, parseOpencodeRunnerArgs, parsePermissionRequest, permissionOutcome,
  type OpencodeRunnerIo,
} from "../src/adapters/opencode-runner.js";
import type { OpencodeRunnerState } from "../src/adapters/opencode-runner-protocol.js";

const SID = "ses_eb49b1749ffeC6daza8UI6Qof5";
const OTHER = "ses_zzzzzzzzzzzzzzzzzzzzzzzzzz";

function harness(opts: { resume?: string; posture?: "floor" | "auto" | "full_bypass"; model?: string } = {}) {
  const sent: Array<Record<string, any>> = [];
  const mirror: string[] = [];
  const activity: Array<Record<string, unknown>> = [];
  const sidecars: OpencodeRunnerState[] = [];
  const signals: string[] = [];
  let spawns = 0;
  let exitCode: number | undefined;
  let tick = 0;
  const io: OpencodeRunnerIo = {
    sendToChild: (l) => { sent.push(JSON.parse(l)); },
    signalChild: (s) => { signals.push(s); },
    spawnChild: () => { spawns++; },
    mirrorLine: (l) => { mirror.push(`${l}\n`); },
    mirrorAppend: (t) => { mirror.push(t); },
    postActivity: (p) => { activity.push(p); },
    writeSidecar: (s) => { sidecars.push(s); },
    exit: (c) => { exitCode = c; },
    now: () => `2026-10-18T00:00:${String(tick++).padStart(2, "0")}Z`,
  };
  const core = new OpencodeRunnerCore(io, {
    sessionName: "orch@dev-team", nodeId: "node-1", generation: "3", launchId: "L1",
    posture: opts.posture ?? "floor", cwd: "/work", model: opts.model,
  }, opts.resume, 1000);
  const line = (o: Record<string, unknown>) => core.onChildLine(JSON.stringify({ jsonrpc: "2.0", ...o }));
  const methods = () => sent.map((m) => m.method).filter(Boolean) as string[];
  const lastRequest = (method: string) => [...sent].reverse().find((m) => m.method === method)!;
  /** Answer the handshake: initialize -> session/new|resume -> (set model). */
  const handshake = (sessionId = SID) => {
    core.start();
    line({ id: lastRequest("initialize").id, result: { protocolVersion: 1 } });
    if (opts.resume) line({ id: lastRequest("session/resume").id, result: {} });
    else line({ id: lastRequest("session/new").id, result: { sessionId } });
    if (opts.model) line({ id: lastRequest("session/set_config_option").id, result: {} });
  };
  const update = (u: Record<string, unknown>) => line({ method: "session/update", params: { sessionId: SID, update: u } });
  const finishPrompt = (stopReason = "end_turn") => line({ id: lastRequest("session/prompt").id, result: { stopReason } });
  const text = () => mirror.join("");
  const lastSidecar = () => sidecars[sidecars.length - 1]!;
  const askPermission = (id = 77) => line({
    id, method: "session/request_permission",
    params: { sessionId: SID, toolCall: { toolCallId: "t", title: "rm -rf build", kind: "execute" },
      options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "always", kind: "allow_always", name: "Always" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] },
  });
  const replies = (id: number) => sent.filter((m) => m.id === id && m.result);
  return { core, sent, mirror, activity, sidecars, signals, line, handshake, update, finishPrompt, text, lastSidecar, methods, lastRequest, askPermission, replies,
    get spawns() { return spawns; }, get exitCode() { return exitCode; } };
}

describe("mapOpencodeUpdate", () => {
  const titles = () => new Map<string, string>();
  it("appends streamed assistant text and ignores thoughts and other updates", () => {
    expect(mapOpencodeUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } }, titles())).toEqual({ mirrorLines: [], mirrorAppend: "pong" });
    for (const sessionUpdate of ["agent_thought_chunk", "usage_update", "available_commands_update", "config_option_update", "plan", "brand_new"]) {
      expect(mapOpencodeUpdate({ sessionUpdate, content: { type: "text", text: "x" } }, titles())).toEqual({ mirrorLines: [] });
    }
    expect(mapOpencodeUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "image" } }, titles())).toEqual({ mirrorLines: [] });
  });
  it("shows a tool once it runs, using the real command title, and posts PreToolUse", () => {
    const t = titles();
    const announced = mapOpencodeUpdate({ sessionUpdate: "tool_call", toolCallId: "a", title: "bash", kind: "execute", status: "pending" }, t);
    expect(announced.mirrorLines).toEqual([]);
    const running = mapOpencodeUpdate({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "in_progress", kind: "execute", title: "echo   hi\n&& id" }, t);
    expect(running.mirrorLines).toEqual(["  ⚙ execute echo hi && id …"]);
    expect(running.activity).toEqual({ hookEvent: "PreToolUse", subtype: "execute" });
    expect(running.closesLine).toBe(true);
  });
  it("remembers a call's kind for a completion update that omits it", () => {
    const t = titles();
    const k = new Map<string, string>();
    mapOpencodeUpdate({ sessionUpdate: "tool_call_update", toolCallId: "w", status: "in_progress", kind: "edit", title: "write" }, t, k);
    expect(mapOpencodeUpdate({ sessionUpdate: "tool_call_update", toolCallId: "w", status: "completed" }, t, k).mirrorLines).toEqual(["  ⚙ edit done"]);
  });
  it("marks tool completion and failure and forgets the call", () => {
    const t = titles();
    t.set("a", "ls");
    expect(mapOpencodeUpdate({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed", kind: "read" }, t).mirrorLines).toEqual(["  ⚙ read done"]);
    expect(t.has("a")).toBe(false);
    expect(mapOpencodeUpdate({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "failed", kind: "edit" }, t).mirrorLines).toEqual(["  ⚙ edit FAILED"]);
  });
});

describe("permission requests", () => {
  const request = parsePermissionRequest(5, {
    toolCall: { title: "git push", kind: "execute" },
    options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "always", kind: "allow_always", name: "Always" }, { optionId: "reject", kind: "reject_once", name: "Reject" }, { nope: 1 }],
  });
  it("parses the tool and the offered options, skipping malformed ones", () => {
    expect(request).toMatchObject({ rpcId: 5, title: "git push", kind: "execute" });
    expect(request.options.map((o) => o.optionId)).toEqual(["once", "always", "reject"]);
  });
  it("maps decisions to the agent's own option ids", () => {
    expect(permissionOutcome(request, "allow")).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    expect(permissionOutcome(request, "always")).toEqual({ outcome: { outcome: "selected", optionId: "always" } });
    expect(permissionOutcome(request, "deny")).toEqual({ outcome: { outcome: "selected", optionId: "reject" } });
  });
  it("falls back to cancelled when no option fits, and never upgrades a deny to an allow", () => {
    const allowOnly = parsePermissionRequest(1, { options: [{ optionId: "ok", kind: "allow_once", name: "ok" }] });
    expect(permissionOutcome(allowOnly, "deny")).toEqual({ outcome: { outcome: "cancelled" } });
    expect(permissionOutcome(parsePermissionRequest(1, {}), "allow")).toEqual({ outcome: { outcome: "cancelled" } });
  });
});

describe("OpencodeRunnerCore handshake", () => {
  const modelOptions = (current: string) => [{ id: "model", category: "model", type: "select", currentValue: current, options: [] }];
  it("records the session's current model from configOptions", () => {
    const h = harness();
    h.core.start();
    h.line({ id: h.lastRequest("initialize").id, result: { protocolVersion: 1 } });
    h.line({ id: h.lastRequest("session/new").id, result: { sessionId: SID, configOptions: modelOptions("opencode/big-pickle") } });
    expect(h.lastSidecar().model).toBe("opencode/big-pickle");
  });
  it("prefers the model reported after set_config_option, and falls back to the requested one", () => {
    const reported = harness({ model: "opencode/glm-5.3-flash-free" });
    reported.core.start();
    reported.line({ id: reported.lastRequest("initialize").id, result: { protocolVersion: 1 } });
    reported.line({ id: reported.lastRequest("session/new").id, result: { sessionId: SID, configOptions: modelOptions("opencode/big-pickle") } });
    reported.line({ id: reported.lastRequest("session/set_config_option").id, result: { configOptions: modelOptions("opencode/glm-5.3-flash-free") } });
    expect(reported.lastSidecar().model).toBe("opencode/glm-5.3-flash-free");

    const fallback = harness({ model: "opencode/glm-5.3-flash-free" });
    fallback.handshake();
    expect(fallback.lastSidecar().model).toBe("opencode/glm-5.3-flash-free");
  });
  it("leaves the model unset when the session reports none and none was requested", () => {
    const h = harness();
    h.handshake();
    expect(h.lastSidecar().model).toBeUndefined();
  });
  it("initializes, opens a new session and becomes ready", () => {
    const h = harness();
    h.core.start();
    expect(h.spawns).toBe(1);
    expect(h.sent[0]).toMatchObject({ method: "initialize", params: { protocolVersion: 1, clientCapabilities: { terminal: false } } });
    h.line({ id: h.sent[0]!.id, result: {} });
    expect(h.lastRequest("session/new").params).toEqual({ cwd: "/work", mcpServers: [] });
    expect(h.core.phase).toBe("starting");
    h.line({ id: h.lastRequest("session/new").id, result: { sessionId: SID } });
    expect(h.core.phase).toBe("idle");
    expect(h.lastSidecar()).toMatchObject({ ready: true, launchId: "L1", sessionId: SID, busy: false });
    expect(h.text()).toContain(`[opencode-runner] READY session ${SID}`);
    expect(h.activity).toContainEqual(expect.objectContaining({
      eventFamily: "session_identity", runtime: "opencode", sessionName: "orch@dev-team", sessionId: SID, hookEvent: "SessionStart", generation: "3", nodeId: "node-1",
    }));
  });

  it("selects the configured model before reporting ready", () => {
    const h = harness({ model: "opencode/glm-5.3-flash-free" });
    h.core.start();
    h.line({ id: h.sent[0]!.id, result: {} });
    h.line({ id: h.lastRequest("session/new").id, result: { sessionId: SID } });
    expect(h.core.phase).toBe("starting");
    expect(h.lastRequest("session/set_config_option").params).toEqual({ sessionId: SID, configId: "model", value: "opencode/glm-5.3-flash-free" });
    h.line({ id: h.lastRequest("session/set_config_option").id, result: {} });
    expect(h.core.phase).toBe("idle");
  });

  it("fails when the model cannot be selected rather than running on a default", () => {
    const h = harness({ model: "nope/none" });
    h.core.start();
    h.line({ id: h.sent[0]!.id, result: {} });
    h.line({ id: h.lastRequest("session/new").id, result: { sessionId: SID } });
    h.line({ id: h.lastRequest("session/set_config_option").id, error: { code: -32602, message: "unknown model" } });
    expect(h.core.phase).toBe("exited");
    expect(h.text()).toContain("rejected setModel: unknown model");
    expect(h.exitCode).toBe(1);
  });

  it("resumes the requested session through session/resume", () => {
    const h = harness({ resume: SID });
    h.handshake();
    expect(h.lastRequest("session/resume").params).toEqual({ sessionId: SID, cwd: "/work", mcpServers: [] });
    expect(h.methods()).not.toContain("session/new");
    expect(h.core.phase).toBe("idle");
    expect(h.lastSidecar().sessionId).toBe(SID);
  });

  it("fails when a resume names a different session or is rejected", () => {
    const a = harness({ resume: SID });
    a.core.start();
    a.line({ id: a.sent[0]!.id, result: {} });
    a.line({ id: a.lastRequest("session/resume").id, result: { sessionId: OTHER } });
    expect(a.core.phase).toBe("exited");
    expect(a.text()).toContain(`${OTHER} but ${SID} was requested`);
    const b = harness({ resume: SID });
    b.core.start();
    b.line({ id: b.sent[0]!.id, result: {} });
    b.line({ id: b.lastRequest("session/resume").id, error: { code: -32002, message: "session not found" } });
    expect(b.core.phase).toBe("exited");
    expect(b.text()).toContain("session not found");
    expect(b.lastSidecar().exited).toBeDefined();
  });

  it("rejects a session/new answer without a valid session id", () => {
    const h = harness();
    h.core.start();
    h.line({ id: h.sent[0]!.id, result: {} });
    h.line({ id: h.lastRequest("session/new").id, result: { sessionId: "../etc/passwd" } });
    expect(h.core.phase).toBe("exited");
    expect(h.lastSidecar().ready).toBe(false);
  });

  it("times out when the handshake never completes", () => {
    const h = harness();
    h.core.start();
    h.core.onTick(1000 + OPENCODE_INIT_TIMEOUT_MS - 1);
    expect(h.core.phase).toBe("starting");
    h.core.onTick(1000 + OPENCODE_INIT_TIMEOUT_MS + 1);
    expect(h.core.phase).toBe("exited");
    expect(h.signals).toContain("SIGTERM");
    expect(h.text()).toContain("did not become ready");
  });
});

describe("OpencodeRunnerCore turns", () => {
  it("holds input until ready, then sends one session/prompt", () => {
    const h = harness();
    h.core.start();
    h.core.onPaneInput("hello");
    expect(h.methods()).toEqual(["initialize"]);
    h.line({ id: h.sent[0]!.id, result: {} });
    h.line({ id: h.lastRequest("session/new").id, result: { sessionId: SID } });
    expect(h.lastRequest("session/prompt").params).toEqual({ sessionId: SID, prompt: [{ type: "text", text: "hello" }] });
    expect(h.core.phase).toBe("busy");
    expect(h.lastSidecar().busy).toBe(true);
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "active", subtype: "turn_start", runtime: "opencode" }));
  });

  it("streams text and tools to the pane and reports Stop when the prompt returns", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("run it");
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "in_progress", kind: "execute", title: "ls" });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed", kind: "execute" });
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
    h.finishPrompt();
    const text = h.text();
    expect(text).toContain("⚙ execute ls …");
    expect(text).toContain("⚙ execute done");
    expect(text).toContain("done\n");
    expect(h.core.phase).toBe("idle");
    expect(h.lastSidecar()).toMatchObject({ busy: false, ready: true });
    expect(h.lastSidecar().lastTurnAt).toBeDefined();
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "PreToolUse", subtype: "execute" }));
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "Stop", subtype: "turn_end" }));
  });

  it("terminates a streamed line before printing the next tool line", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("x");
    h.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "thinking aloud" } });
    h.update({ sessionUpdate: "tool_call_update", toolCallId: "a", status: "in_progress", kind: "read", title: "f" });
    expect(h.text()).toContain("thinking aloud\n  ⚙ read f");
  });

  it("serialises queued messages: one prompt at a time, in order", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("first");
    h.core.onPaneInput("second");
    h.core.onPaneInput("third");
    expect(h.methods().filter((m) => m === "session/prompt")).toHaveLength(1);
    expect(h.core.queued).toBe(2);
    expect(h.text()).toContain("queued (2 waiting)");
    h.finishPrompt();
    expect(h.lastRequest("session/prompt").params.prompt[0].text).toBe("second");
    h.finishPrompt();
    expect(h.lastRequest("session/prompt").params.prompt[0].text).toBe("third");
  });

  it("drops input past the queue cap with a visible error", () => {
    const h = harness();
    h.handshake();
    for (let i = 0; i < OPENCODE_MAX_QUEUED_TURNS + 2; i++) h.core.onPaneInput(`m${i}`);
    expect(h.core.queued).toBe(OPENCODE_MAX_QUEUED_TURNS);
    expect(h.text()).toContain("input queue is full");
  });

  it("surfaces a prompt error, ends the turn and goes on to the next", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("a");
    h.core.onPaneInput("b");
    h.line({ id: h.lastRequest("session/prompt").id, error: { code: -32000, message: "provider exploded" } });
    expect(h.text()).toContain("[opencode-runner] ERROR turn failed: provider exploded");
    expect(h.lastRequest("session/prompt").params.prompt[0].text).toBe("b");
    expect(h.core.phase).toBe("busy");
  });

  it("answers agent requests it does not serve with method-not-found", () => {
    const h = harness();
    h.handshake();
    h.line({ id: 9, method: "fs/read_text_file", params: { path: "/etc/passwd" } });
    expect(h.sent.at(-1)).toMatchObject({ id: 9, error: { code: -32601 } });
  });

  it("shows plain non-JSON output and ignores unknown responses", () => {
    const h = harness();
    h.core.start();
    h.core.onChildLine("warning: something");
    h.line({ id: 999, result: {} });
    expect(h.text()).toContain("[opencode] warning: something");
    expect(h.core.phase).toBe("starting");
  });
});

describe("OpencodeRunnerCore cancel", () => {
  it("sends a graceful session/cancel and returns to idle when the prompt reports cancelled", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("long task");
    h.core.onPaneInput("/abort");
    expect(h.core.phase).toBe("cancelling");
    expect(h.sent.at(-1)).toEqual({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: SID } });
    expect(h.signals).toEqual([]);
    h.finishPrompt("cancelled");
    expect(h.core.phase).toBe("idle");
    expect(h.spawns).toBe(1);
    expect(h.text()).toContain("turn cancelled");
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "Stop", subtype: "interrupted" }));
  });

  it("says so when there is nothing to cancel", () => {
    const h = harness();
    h.core.start();
    h.core.onPaneInput("/abort");
    expect(h.text()).toContain("still starting");
  });

  it("escalates to SIGTERM then SIGKILL, then resumes the same session in a new process", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("stubborn");
    h.core.onTick(2000);
    h.core.onPaneInput("/abort");
    h.core.onTick(2000 + OPENCODE_CANCEL_TERM_MS);
    expect(h.signals).toEqual(["SIGTERM"]);
    h.core.onTick(2000 + OPENCODE_CANCEL_KILL_MS);
    expect(h.signals).toEqual(["SIGTERM", "SIGKILL"]);
    h.core.onChildExit(null);
    expect(h.spawns).toBe(2);
    expect(h.core.phase).toBe("starting");
    h.line({ id: h.lastRequest("initialize").id, result: {} });
    expect(h.lastRequest("session/resume").params.sessionId).toBe(SID);
    h.line({ id: h.lastRequest("session/resume").id, result: {} });
    expect(h.core.phase).toBe("idle");
    expect(h.text()).toContain(`opencode restarted on session ${SID}`);
  });

  it("resumes the session when the cancelled answer races the forced stop", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("stubborn");
    h.core.onTick(2000);
    h.core.onPaneInput("/abort");
    h.core.onTick(2000 + OPENCODE_CANCEL_TERM_MS);
    expect(h.signals).toEqual(["SIGTERM"]);
    h.finishPrompt("cancelled");
    expect(h.core.phase).toBe("idle");
    h.core.onChildExit(143);
    expect(h.core.phase).toBe("starting");
    expect(h.spawns).toBe(2);
    expect(h.exitCode).toBeUndefined();
  });

  it("refuses a permission request that arrives after /abort", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("x");
    h.core.onPaneInput("/abort");
    h.askPermission(41);
    expect(h.replies(41)[0]).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
    expect(h.core.waitingPermissions).toBe(0);
    expect(h.text()).not.toContain("PERMISSION");
    h.core.onPaneInput("/allow");
    expect(h.replies(41)).toHaveLength(1);
  });

  it("answers waiting permission requests cancelled when the turn is cancelled", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("x");
    h.askPermission(77);
    h.core.onPaneInput("/abort");
    expect(h.replies(77)[0]).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
    expect(h.core.waitingPermissions).toBe(0);
  });
});

describe("OpencodeRunnerCore permissions", () => {
  it("shows the request, reports needs-input and answers /allow with the offered option", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("x");
    h.askPermission(77);
    expect(h.text()).toContain("PERMISSION execute: rm -rf build");
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "PermissionRequest", subtype: "execute" }));
    expect(h.lastSidecar().awaitingPermission).toBe(true);
    h.core.onPaneInput("/allow");
    expect(h.replies(77)[0]).toMatchObject({ result: { outcome: { outcome: "selected", optionId: "once" } } });
    expect(h.lastSidecar().awaitingPermission).toBe(false);
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "active", subtype: "permission_resolved" }));
    // Control replies are never forwarded to the model as chat.
    expect(h.methods().filter((m) => m === "session/prompt")).toHaveLength(1);
  });

  it("maps /always and /deny, one request at a time in arrival order", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("x");
    h.askPermission(1);
    h.askPermission(2);
    h.core.onPaneInput("/deny");
    h.core.onPaneInput("/always");
    expect(h.replies(1)[0]).toMatchObject({ result: { outcome: { optionId: "reject" } } });
    expect(h.replies(2)[0]).toMatchObject({ result: { outcome: { optionId: "always" } } });
  });

  it("denies an unanswered request after the timeout", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("x");
    h.core.onTick(1000);
    h.askPermission(5);
    h.core.onTick(1000 + OPENCODE_PERMISSION_TIMEOUT_MS - 1);
    expect(h.replies(5)).toHaveLength(0);
    h.core.onTick(1000 + OPENCODE_PERMISSION_TIMEOUT_MS + 1);
    expect(h.replies(5)[0]).toMatchObject({ result: { outcome: { optionId: "reject" } } });
    expect(h.text()).toContain("timed out; denied");
  });

  it("settles requests still waiting when the prompt ends", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("x");
    h.askPermission(8);
    h.finishPrompt();
    expect(h.replies(8)[0]).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
  });

  it("says so when /allow arrives with nothing waiting", () => {
    const h = harness();
    h.handshake();
    h.core.onPaneInput("/allow");
    expect(h.text()).toContain("no permission request is waiting");
  });

  it("never leaves a bypass seat waiting if opencode asks anyway", () => {
    const h = harness({ posture: "full_bypass" });
    h.handshake();
    h.core.onPaneInput("x");
    h.askPermission(3);
    expect(h.replies(3)[0]).toMatchObject({ result: { outcome: { optionId: "once" } } });
    expect(h.core.waitingPermissions).toBe(0);
  });
});

describe("OpencodeRunnerCore exits", () => {
  it("records a child crash in the sidecar, prints markers and exits non-zero", () => {
    const h = harness();
    h.handshake();
    h.core.onChildExit(3);
    expect(h.core.phase).toBe("exited");
    expect(h.exitCode).toBe(1);
    expect(h.text()).toContain("[opencode-runner] ERROR opencode exited with code 3");
    expect(h.text()).toContain("[opencode-runner] EXITED");
    expect(h.lastSidecar()).toMatchObject({ ready: false, exited: { code: 3 }, sessionId: SID });
    expect(h.activity).toContainEqual(expect.objectContaining({ hookEvent: "Stop", subtype: "opencode_exited" }));
  });

  it("shuts down cleanly with exit 0 when the runner is told to stop", () => {
    const h = harness();
    h.handshake();
    h.core.shutdown("runner received SIGTERM");
    expect(h.signals).toContain("SIGTERM");
    expect(h.exitCode).toBe(0);
    expect(h.text()).toContain("[opencode-runner] EXITED runner received SIGTERM");
  });
});

describe("parseOpencodeRunnerArgs", () => {
  const base = ["--session-name", "s", "--state-root", "/r", "--cwd", "/w", "--launch-id", "L", "--posture", "auto"];
  it("parses the full set", () => {
    expect(parseOpencodeRunnerArgs([...base, "--model", "opencode/glm-5.3-flash-free", "--session", SID])).toEqual({
      sessionName: "s", stateRoot: "/r", cwd: "/w", launchId: "L", posture: "auto", model: "opencode/glm-5.3-flash-free", sessionId: SID,
    });
  });
  it.each([
    [[...base, "--model", "bare"], "<provider>/<model>"],
    [[...base, "--session", "--evil"], "session id"],
    [[...base, "--bogus", "1"], "unknown flag"],
    [["--session-name", "s"], "--state-root is required"],
    [[...base.slice(0, -1), "root"], "unsupported posture"],
    [[...base, "--model"], "requires a value"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseOpencodeRunnerArgs(argv as string[])).toThrow(message);
  });
});
