// The pane-hosted opencode-runner (compiled entry in the daemon dist).
//
// It makes an opencode seat behave like a normal OpenRig tmux seat while
// everything underneath stays structured ACP (Agent Client Protocol, JSON-RPC 2.0
// over `opencode acp` stdio):
//
//   pane stdin (rig send / human typing) ──▶ one session/prompt turn at a time
//   ACP session/update notifications     ──▶ (a) human-readable pane mirror
//                                            (b) activity + session_identity
//                                                POSTs to the daemon
//                                            (c) runner-state.json sidecar
//   ACP session/request_permission       ──▶ pane prompt; /allow /always /deny
//
// Activity and session identity derive only from typed ACP messages, never from
// pane scraping. The opencode child gets a deny-by-default env allowlist. A dead
// opencode prints the EXIT/ERROR marker and records `exited` in the sidecar,
// never a silently frozen pane.
//
// opencode facts this relies on (verified against opencode 1.19.3):
//   - `initialize` -> `session/new {cwd, mcpServers}` (or `session/resume {sessionId,...}`)
//     is the readiness sequence; the session id (`ses_...`) is the resume token.
//   - A resume in a fresh process restores history and the selected model.
//   - `session/set_config_option {configId:"model", value:"<provider>/<model>"}` selects the model.
//   - `session/cancel` is a graceful notification: the in-flight `session/prompt` returns
//     stopReason "cancelled" and the process stays up. No respawn is needed; a child that
//     never answers is escalated (SIGTERM) and respawned on the same session.
//   - Edit and bash run without asking unless the opencode config says `ask`; the runner
//     injects that config for the floor/auto postures (see buildOpencodePostureConfig)
//     and answers the resulting `session/request_permission` requests from the pane.
//
// Only node builtins and local runner helpers are imported so the compiled entry
// stays runnable as `node <dist>/adapters/opencode-runner.js` with no daemon deps.

import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import readline from "node:readline";
import { createRunnerInput, resolveActivityEndpoint, resolveRuntimeExecutable } from "./pi-runner.js";
import {
  ACP_PROTOCOL_VERSION, OPENCODE_RUNNER_ERROR_MARKER, OPENCODE_RUNNER_EXIT_MARKER, OPENCODE_RUNNER_READY_MARKER,
  acpTextPrompt, buildOpencodeChildArgs, buildOpencodeChildEnv, buildPendingOpencodeRunnerState,
  encodeAcpError, encodeAcpNotification, encodeAcpRequest, encodeAcpResult,
  isOpencodeModelId, isOpencodeSessionId, opencodeSeatPaths, parseOpencodeRunnerState,
  type OpencodePosture, type OpencodeRunnerState,
} from "./opencode-runner-protocol.js";

// ── ACP update → mirror + activity mapping (pure, hermetically testable) ─────

export interface OpencodeMapped {
  /** Lines to print to the pane (already human-readable). */
  mirrorLines: string[];
  /** Raw text to append to the current mirror line (streamed deltas). */
  mirrorAppend?: string;
  /** Activity POST payload, when the update maps to one. */
  activity?: { hookEvent: string; subtype: string | null };
  /** A tool step began or finished: lets the core close an open streamed line first. */
  closesLine?: boolean;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function oneLine(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Map one ACP `session/update` payload. `toolTitles` remembers each tool call's title across updates. */
export function mapOpencodeUpdate(update: Record<string, unknown>, toolTitles: Map<string, string>): OpencodeMapped {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const content = (update.content ?? {}) as Record<string, unknown>;
      const text = content.type === "text" ? str(content.text) : undefined;
      return text ? { mirrorLines: [], mirrorAppend: text } : { mirrorLines: [] };
    }
    case "tool_call": {
      const id = str(update.toolCallId);
      const title = str(update.title) ?? "tool";
      if (id) toolTitles.set(id, title);
      // opencode announces the call as `pending` with only a placeholder title; the real
      // command arrives on the first tool_call_update, which is what is shown.
      return { mirrorLines: [], closesLine: true };
    }
    case "tool_call_update": {
      const id = str(update.toolCallId);
      const status = str(update.status);
      const title = str(update.title) ?? (id ? toolTitles.get(id) : undefined) ?? "tool";
      if (id) toolTitles.set(id, title);
      const kind = str(update.kind) ?? "tool";
      if (status === "in_progress") {
        return {
          mirrorLines: [`  ⚙ ${kind} ${oneLine(title)} …`],
          activity: { hookEvent: "PreToolUse", subtype: kind },
          closesLine: true,
        };
      }
      if (status === "completed") {
        if (id) toolTitles.delete(id);
        return { mirrorLines: [`  ⚙ ${kind} done`], closesLine: true };
      }
      if (status === "failed") {
        if (id) toolTitles.delete(id);
        return { mirrorLines: [`  ⚙ ${kind} FAILED`], closesLine: true };
      }
      return { mirrorLines: [] };
    }
    default:
      // agent_thought_chunk, user_message_chunk, plan, usage_update, available_commands_update,
      // config_option_update, current_mode_update and any update type this runner does not know.
      return { mirrorLines: [] };
  }
}

export interface OpencodePermissionOption {
  optionId: string;
  kind: string;
  name: string;
}

export interface OpencodePermissionRequest {
  rpcId: number | string;
  title: string;
  kind: string;
  options: OpencodePermissionOption[];
}

export function parsePermissionRequest(rpcId: number | string, params: Record<string, unknown>): OpencodePermissionRequest {
  const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
  const options = Array.isArray(params.options)
    ? (params.options as unknown[]).flatMap((entry): OpencodePermissionOption[] => {
        const option = (entry ?? {}) as Record<string, unknown>;
        return typeof option.optionId === "string"
          ? [{ optionId: option.optionId, kind: str(option.kind) ?? "", name: str(option.name) ?? option.optionId }]
          : [];
      })
    : [];
  return { rpcId, title: str(toolCall.title) ?? "tool call", kind: str(toolCall.kind) ?? "tool", options };
}

export type PermissionDecision = "allow" | "always" | "deny";

/** The ACP outcome for a decision, or `cancelled` when the agent offered no matching option. */
export function permissionOutcome(request: OpencodePermissionRequest, decision: PermissionDecision): Record<string, unknown> {
  const wanted = decision === "allow" ? ["allow_once", "allow_always"]
    : decision === "always" ? ["allow_always", "allow_once"]
    : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const option = request.options.find((o) => o.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

// ── The runner core (injected effects; owns the state machine) ──────────────

export interface OpencodeRunnerIo {
  /** Write one NDJSON line to the live opencode child's stdin. */
  sendToChild(line: string): void;
  /** Signal the live opencode child. */
  signalChild(signal: NodeJS.Signals): void;
  /** Start a new opencode child. */
  spawnChild(): void;
  mirrorLine(line: string): void;
  mirrorAppend(text: string): void;
  postActivity(payload: Record<string, unknown>): void | Promise<Record<string, unknown> | null>;
  writeSidecar(state: OpencodeRunnerState): void;
  /** End the runner process. */
  exit(code: number): void;
  now(): string;
}

export type OpencodePhase = "starting" | "idle" | "busy" | "cancelling" | "exited";

export interface OpencodeRunnerIdentity {
  sessionName: string;
  nodeId?: string;
  generation?: string;
  launchId: string;
  posture: OpencodePosture;
  cwd: string;
  model?: string;
}

export const OPENCODE_MAX_QUEUED_TURNS = 100;
export const OPENCODE_INIT_TIMEOUT_MS = 90_000;
/** A cancel opencode has not answered escalates: SIGTERM (then a respawn on the same session) after this long. */
export const OPENCODE_CANCEL_TERM_MS = 10_000;
export const OPENCODE_CANCEL_KILL_MS = 15_000;
/** An unanswered permission request is denied after this long, so an unattended seat never wedges. */
export const OPENCODE_PERMISSION_TIMEOUT_MS = 300_000;

type RpcKind = "initialize" | "newSession" | "resumeSession" | "setModel" | "prompt";

export class OpencodeRunnerCore {
  phase: OpencodePhase = "starting";
  sessionId: string | undefined;
  private ready = false;
  private everReady = false;
  private lineOpen = false;
  private streamedThisTurn = false;
  private queue: string[] = [];
  private nextRpcId = 1;
  private pending = new Map<number, RpcKind>();
  private toolTitles = new Map<string, string>();
  private permissions: Array<{ request: OpencodePermissionRequest; askedAtMs: number }> = [];
  private startedAtMs: number;
  private clockMs: number;
  private lastTurnAt: string | undefined;
  private cancelledAtMs = 0;
  private cancelEscalation: 0 | 1 | 2 = 0;

  constructor(
    private readonly io: OpencodeRunnerIo,
    private readonly identity: OpencodeRunnerIdentity,
    resumeSessionId: string | undefined,
    nowMs: number,
  ) {
    this.sessionId = resumeSessionId;
    this.startedAtMs = nowMs;
    this.clockMs = nowMs;
  }

  get queued(): number { return this.queue.length; }
  get waitingPermissions(): number { return this.permissions.length; }

  /** Begin: spawn the child and open the ACP handshake. */
  start(): void {
    this.io.spawnChild();
    this.handshake();
  }

  /** Pane input: a message for opencode, or a control (/abort, /allow, /always, /deny). */
  onPaneInput(block: string): void {
    const text = block.trim();
    if (!text) return;
    if (text === "/abort") { this.cancel(); return; }
    if (text === "/allow" || text === "/always" || text === "/deny") {
      this.decidePermission(text.slice(1) as PermissionDecision);
      return;
    }
    if (this.phase === "exited") return;
    if (this.queue.length >= OPENCODE_MAX_QUEUED_TURNS) {
      this.closeLine();
      this.io.mirrorLine(`${OPENCODE_RUNNER_ERROR_MARKER} input queue is full (${OPENCODE_MAX_QUEUED_TURNS}); message dropped`);
      return;
    }
    this.queue.push(text);
    if (this.phase === "busy" || this.phase === "cancelling") {
      this.closeLine();
      this.io.mirrorLine(`[opencode-runner] queued (${this.queue.length} waiting)`);
    }
    this.dispatchNext();
  }

  /** One decoded stdout line from the opencode child. */
  onChildLine(rawLine: string): void {
    if (this.phase === "exited") return;
    const line = stripVTControlCharacters(rawLine).trim();
    if (!line) return;
    let message: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      message = parsed as Record<string, unknown>;
    } catch {
      // opencode may print plain diagnostics beside the JSON-RPC stream.
      this.closeLine();
      this.io.mirrorLine(`[opencode] ${line}`);
      return;
    }
    const id = message.id;
    const hasMethod = typeof message.method === "string";
    if (!hasMethod && (typeof id === "number")) { this.onResponse(id, message); return; }
    if (hasMethod && id === undefined) { this.onNotification(message.method as string, (message.params ?? {}) as Record<string, unknown>); return; }
    if (hasMethod && (typeof id === "number" || typeof id === "string")) {
      this.onAgentRequest(id, message.method as string, (message.params ?? {}) as Record<string, unknown>);
    }
  }

  /** The opencode child exited (or was killed). */
  onChildExit(code: number | null): void {
    if (this.phase === "exited") return;
    if (this.phase === "cancelling" && this.sessionId && this.ready) {
      // opencode ignored the cancel and had to be signalled: resume the same session.
      this.closeLine();
      this.io.mirrorLine("[opencode-runner] cancelled; restarting opencode on the same session");
      this.respawnOnSession();
      this.io.postActivity(this.activityPayload("Stop", "interrupted"));
      return;
    }
    this.fail(code, code === 0 ? "opencode exited" : `opencode exited with code ${code ?? "unknown"}`);
  }

  /** Called periodically: bounds the handshake, cancel escalation and permission waits. */
  onTick(nowMs: number): void {
    this.clockMs = nowMs;
    if (this.phase === "cancelling") {
      const waited = nowMs - this.cancelledAtMs;
      if (this.cancelEscalation < 2 && waited >= OPENCODE_CANCEL_KILL_MS) {
        this.cancelEscalation = 2;
        this.closeLine();
        this.io.mirrorLine("[opencode-runner] opencode ignored SIGTERM; killing it");
        this.io.signalChild("SIGKILL");
      } else if (this.cancelEscalation < 1 && waited >= OPENCODE_CANCEL_TERM_MS) {
        this.cancelEscalation = 1;
        this.closeLine();
        this.io.mirrorLine("[opencode-runner] opencode did not honour the cancel; sending SIGTERM");
        this.io.signalChild("SIGTERM");
      }
    }
    if (this.phase === "starting" && nowMs - this.startedAtMs > OPENCODE_INIT_TIMEOUT_MS) {
      this.io.signalChild("SIGTERM");
      this.fail(null, `opencode did not become ready within ${OPENCODE_INIT_TIMEOUT_MS / 1000}s`);
      return;
    }
    const head = this.permissions[0];
    if (head && nowMs - head.askedAtMs >= OPENCODE_PERMISSION_TIMEOUT_MS) {
      this.closeLine();
      this.io.mirrorLine(`[opencode-runner] permission for "${oneLine(head.request.title)}" timed out; denied`);
      this.decidePermission("deny");
    }
  }

  /** The runner itself was asked to stop (SIGTERM/SIGHUP). */
  shutdown(reason: string): void {
    if (this.phase === "exited") return;
    this.io.signalChild("SIGTERM");
    this.fail(null, reason, 0);
  }

  // ── ACP handshake ──────────────────────────────────────────────────────────

  private call(kind: RpcKind, method: string, params: Record<string, unknown>): void {
    const id = this.nextRpcId++;
    this.pending.set(id, kind);
    this.io.sendToChild(encodeAcpRequest(id, method, params));
  }

  private handshake(): void {
    this.call("initialize", "initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // The runner serves neither client-side file access nor terminals; opencode uses its own tools.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
  }

  private onResponse(id: number, message: Record<string, unknown>): void {
    const kind = this.pending.get(id);
    if (!kind) return;
    this.pending.delete(id);
    const error = message.error as Record<string, unknown> | undefined;
    const result = (message.result ?? {}) as Record<string, unknown>;
    if (error) {
      const text = str(error.message) ?? "unknown error";
      if (kind === "prompt") { this.onPromptFailed(text); return; }
      this.fail(null, `opencode rejected ${kind}: ${text}`);
      return;
    }
    switch (kind) {
      case "initialize":
        if (this.sessionId) this.call("resumeSession", "session/resume", { sessionId: this.sessionId, cwd: this.identity.cwd, mcpServers: [] });
        else this.call("newSession", "session/new", { cwd: this.identity.cwd, mcpServers: [] });
        break;
      case "newSession": {
        const sid = str(result.sessionId);
        if (!isOpencodeSessionId(sid)) { this.fail(null, "opencode session/new carried no valid session id"); return; }
        this.sessionId = sid;
        this.afterSession();
        break;
      }
      case "resumeSession": {
        // The response omits the id; the requested session is the one that resumed.
        const echoed = str(result.sessionId);
        if (echoed && echoed !== this.sessionId) {
          this.fail(null, `opencode resumed session ${echoed} but ${this.sessionId} was requested`);
          return;
        }
        this.afterSession();
        break;
      }
      case "setModel":
        this.becomeReady();
        break;
      case "prompt":
        this.onPromptDone(str(result.stopReason) ?? "end_turn");
        break;
    }
  }

  private afterSession(): void {
    if (this.identity.model) {
      this.call("setModel", "session/set_config_option", {
        sessionId: this.sessionId, configId: "model", value: this.identity.model,
      });
    } else {
      this.becomeReady();
    }
  }

  private becomeReady(): void {
    this.ready = true;
    this.phase = "idle";
    this.writeSidecar({ busy: false });
    this.closeLine();
    this.io.mirrorLine(this.everReady
      ? `[opencode-runner] opencode restarted on session ${this.sessionId}`
      : `${OPENCODE_RUNNER_READY_MARKER} session ${this.sessionId}`);
    this.everReady = true;
    this.postSessionIdentity();
    this.dispatchNext();
  }

  // ── turns ──────────────────────────────────────────────────────────────────

  private dispatchNext(): void {
    if (this.phase !== "idle" || this.queue.length === 0) return;
    const text = this.queue.shift()!;
    this.phase = "busy";
    this.streamedThisTurn = false;
    this.writeSidecar({ busy: true });
    this.io.postActivity(this.activityPayload("active", "turn_start"));
    this.io.mirrorLine(`> ${text.split("\n")[0]!.slice(0, 200)}${text.includes("\n") || text.length > 200 ? " …" : ""}`);
    this.call("prompt", "session/prompt", { sessionId: this.sessionId, prompt: acpTextPrompt(text) });
  }

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method !== "session/update") return;
    const mapped = mapOpencodeUpdate((params.update ?? {}) as Record<string, unknown>, this.toolTitles);
    if (mapped.closesLine) this.closeLine();
    for (const line of mapped.mirrorLines) {
      this.closeLine();
      this.io.mirrorLine(line);
    }
    if (mapped.mirrorAppend !== undefined) {
      this.io.mirrorAppend(mapped.mirrorAppend);
      this.lineOpen = !mapped.mirrorAppend.endsWith("\n");
      this.streamedThisTurn = true;
    }
    if (mapped.activity) this.io.postActivity(this.activityPayload(mapped.activity.hookEvent, mapped.activity.subtype));
  }

  private onAgentRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === "session/request_permission") {
      this.onPermissionRequest(id, params);
      return;
    }
    // The runner advertised no fs or terminal capability, so nothing else is served.
    this.io.sendToChild(encodeAcpError(id, -32601, `method not supported by the OpenRig runner: ${method}`));
  }

  private onPromptDone(stopReason: string): void {
    this.closeLine();
    if (this.phase !== "busy" && this.phase !== "cancelling") return;
    this.settlePermissions();
    if (stopReason === "cancelled") this.io.mirrorLine("[opencode-runner] turn cancelled");
    else if (stopReason !== "end_turn") this.io.mirrorLine(`[opencode-runner] turn stopped: ${stopReason}`);
    this.endTurn(stopReason === "cancelled" ? "interrupted" : "turn_end");
  }

  private onPromptFailed(message: string): void {
    this.closeLine();
    if (this.phase !== "busy" && this.phase !== "cancelling") return;
    this.settlePermissions();
    this.io.mirrorLine(`${OPENCODE_RUNNER_ERROR_MARKER} turn failed: ${message}`);
    this.endTurn("turn_end");
  }

  private endTurn(subtype: string): void {
    this.lastTurnAt = this.io.now();
    this.phase = "idle";
    this.toolTitles.clear();
    this.writeSidecar({ busy: false, lastTurnAt: this.lastTurnAt });
    this.io.postActivity(this.activityPayload("Stop", subtype));
    this.dispatchNext();
  }

  private cancel(): void {
    if (this.phase !== "busy") {
      this.closeLine();
      this.io.mirrorLine(this.phase === "starting" ? "[opencode-runner] opencode is still starting; nothing to interrupt"
        : this.phase === "cancelling" ? "[opencode-runner] already cancelling" : "[opencode-runner] nothing to interrupt");
      return;
    }
    this.closeLine();
    this.io.mirrorLine("[opencode-runner] cancelling the current turn");
    this.phase = "cancelling";
    this.cancelledAtMs = this.clockMs;
    this.cancelEscalation = 0;
    // Outstanding permission requests are answered "cancelled" so opencode is not left waiting on them.
    this.settlePermissions();
    this.io.sendToChild(encodeAcpNotification("session/cancel", { sessionId: this.sessionId }));
  }

  private respawnOnSession(): void {
    this.ready = false;
    this.pending.clear();
    this.permissions = [];
    this.toolTitles.clear();
    this.phase = "starting";
    this.startedAtMs = this.clockMs;
    this.writeSidecar({ busy: false, awaitingPermission: false });
    this.io.spawnChild();
    this.handshake();
  }

  // ── permissions ────────────────────────────────────────────────────────────

  private onPermissionRequest(rpcId: number | string, params: Record<string, unknown>): void {
    const request = parsePermissionRequest(rpcId, params);
    if (this.identity.posture === "full_bypass") {
      // Not expected (no ask rules are injected), but never leave opencode waiting.
      this.io.sendToChild(encodeAcpResult(rpcId, permissionOutcome(request, "allow")));
      return;
    }
    this.permissions.push({ request, askedAtMs: this.clockMs });
    this.closeLine();
    this.io.mirrorLine(`[opencode-runner] PERMISSION ${request.kind}: ${oneLine(request.title, 160)}`);
    this.io.mirrorLine(`[opencode-runner] reply /allow, /always or /deny (denied automatically in ${OPENCODE_PERMISSION_TIMEOUT_MS / 1000}s); ${this.permissions.length} waiting`);
    this.writeSidecar({ awaitingPermission: true });
    this.io.postActivity(this.activityPayload("PermissionRequest", request.kind));
  }

  private decidePermission(decision: PermissionDecision): void {
    const head = this.permissions.shift();
    if (!head) {
      this.closeLine();
      this.io.mirrorLine("[opencode-runner] no permission request is waiting");
      return;
    }
    this.io.sendToChild(encodeAcpResult(head.request.rpcId, permissionOutcome(head.request, decision)));
    this.closeLine();
    this.io.mirrorLine(`[opencode-runner] ${decision === "deny" ? "denied" : decision === "always" ? "allowed (always)" : "allowed"}: ${oneLine(head.request.title)}`);
    this.writeSidecar({ awaitingPermission: this.permissions.length > 0 });
    if (this.permissions.length === 0) this.io.postActivity(this.activityPayload("active", "permission_resolved"));
  }

  /** Answer every waiting request "cancelled" (a turn ended or was cancelled underneath them). */
  private settlePermissions(): void {
    if (this.permissions.length === 0) return;
    for (const { request } of this.permissions) {
      this.io.sendToChild(encodeAcpResult(request.rpcId, { outcome: { outcome: "cancelled" } }));
    }
    this.permissions = [];
    this.writeSidecar({ awaitingPermission: false });
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private fail(code: number | null, message: string, exitCode = 1): void {
    this.phase = "exited";
    this.ready = false;
    this.closeLine();
    this.io.mirrorLine(`${exitCode === 0 ? OPENCODE_RUNNER_EXIT_MARKER : OPENCODE_RUNNER_ERROR_MARKER} ${message}`);
    if (exitCode !== 0) this.io.mirrorLine(OPENCODE_RUNNER_EXIT_MARKER);
    this.io.writeSidecar({
      ready: false,
      launchId: this.identity.launchId,
      sessionId: this.sessionId,
      busy: false,
      lastTurnAt: this.lastTurnAt,
      updatedAt: this.io.now(),
      exited: { code, at: this.io.now() },
    });
    this.io.postActivity(this.activityPayload("Stop", "opencode_exited"));
    this.io.exit(exitCode);
  }

  private closeLine(): void {
    if (!this.lineOpen) return;
    this.io.mirrorLine("");
    this.lineOpen = false;
  }

  private postSessionIdentity(): void {
    this.io.postActivity({
      eventFamily: "session_identity",
      sessionName: this.identity.sessionName,
      nodeId: this.identity.nodeId ?? null,
      runtime: "opencode",
      generation: this.identity.generation ?? null,
      hookEvent: "SessionStart",
      sessionId: this.sessionId ?? "unknown",
      sessionFile: null,
      occurredAt: this.io.now(),
    });
  }

  private activityPayload(hookEvent: string, subtype: string | null): Record<string, unknown> {
    return {
      sessionName: this.identity.sessionName,
      nodeId: this.identity.nodeId ?? null,
      generation: this.identity.generation ?? null,
      runtime: "opencode",
      hookEvent,
      subtype,
      occurredAt: this.io.now(),
    };
  }

  private writeSidecar(patch: Partial<OpencodeRunnerState>): void {
    this.io.writeSidecar({
      ready: this.ready,
      launchId: this.identity.launchId,
      sessionId: this.sessionId,
      lastTurnAt: this.lastTurnAt,
      updatedAt: this.io.now(),
      ...patch,
    });
  }
}

// ── CLI entry ────────────────────────────────────────────────────────────────

export interface OpencodeRunnerArgs {
  sessionName: string;
  stateRoot: string;
  cwd: string;
  launchId: string;
  posture: OpencodePosture;
  model?: string;
  sessionId?: string;
}

export function parseOpencodeRunnerArgs(argv: string[]): OpencodeRunnerArgs {
  const args: Partial<OpencodeRunnerArgs> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} requires a value`);
      return value;
    };
    switch (flag) {
      case "--session-name": args.sessionName = next(); break;
      case "--state-root": args.stateRoot = next(); break;
      case "--cwd": args.cwd = next(); break;
      case "--launch-id": args.launchId = next(); break;
      case "--posture": {
        const posture = next();
        if (posture !== "floor" && posture !== "auto" && posture !== "full_bypass") throw new Error(`unsupported posture: ${posture}`);
        args.posture = posture;
        break;
      }
      case "--model": {
        const model = next();
        if (!isOpencodeModelId(model)) throw new Error(`--model must be <provider>/<model>, got: ${model}`);
        args.model = model;
        break;
      }
      case "--session": {
        const id = next();
        if (!isOpencodeSessionId(id)) throw new Error(`--session must be an opencode session id (ses_...), got: ${id}`);
        args.sessionId = id;
        break;
      }
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  if (!args.sessionName) throw new Error("--session-name is required");
  if (!args.stateRoot) throw new Error("--state-root is required");
  if (!args.cwd) throw new Error("--cwd is required");
  if (!args.launchId) throw new Error("--launch-id is required (launch-attempt scoping)");
  if (!args.posture) throw new Error("--posture is required (floor|auto|full_bypass)");
  return args as OpencodeRunnerArgs;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: OpencodeRunnerArgs;
  try {
    args = parseOpencodeRunnerArgs(argv);
  } catch (err) {
    console.error(`${OPENCODE_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  const paths = opencodeSeatPaths(args.stateRoot, args.sessionName);
  fs.mkdirSync(paths.seatRoot, { recursive: true });

  // Launch-attempt scoping: stamp a pending record before anything else.
  let prior: OpencodeRunnerState | null = null;
  try { prior = parseOpencodeRunnerState(fs.readFileSync(paths.runnerStatePath, "utf8")); } catch { /* absent */ }
  try {
    fs.writeFileSync(paths.runnerStatePath, JSON.stringify(
      buildPendingOpencodeRunnerState(args.launchId, new Date().toISOString(), prior, args.sessionId)));
  } catch { /* best-effort; the adapter pre-writes an equivalent pending record */ }

  const executable = resolveRuntimeExecutable("opencode", process.env);
  if (!executable.ok) {
    console.error(`${OPENCODE_RUNNER_ERROR_MARKER} ${executable.error}`);
    try {
      fs.writeFileSync(paths.runnerStatePath, JSON.stringify({
        ready: false, launchId: args.launchId, updatedAt: new Date().toISOString(),
        exited: { code: 127, at: new Date().toISOString() },
      } satisfies OpencodeRunnerState));
    } catch { /* best-effort */ }
    process.exitCode = 127;
    return;
  }

  const endpoint = resolveActivityEndpoint(process.env);
  const childEnv = buildOpencodeChildEnv(process.env as Record<string, string | undefined>, {
    sessionName: args.sessionName,
    posture: args.posture,
    nodeId: process.env.OPENRIG_NODE_ID,
    openrigHome: process.env.OPENRIG_HOME,
    openrigUrl: endpoint?.baseUrl ?? process.env.OPENRIG_URL,
  });

  console.log(`[opencode-runner] seat ${args.sessionName}: posture ${args.posture}, cwd ${args.cwd}`);

  let child: ChildProcessWithoutNullStreams | null = null;
  let core: OpencodeRunnerCore;

  const io: OpencodeRunnerIo = {
    sendToChild: (line) => {
      try { child?.stdin.write(line); } catch { /* the exit handler reports */ }
    },
    signalChild: (signal) => {
      try { child?.kill(signal); } catch { /* already gone */ }
    },
    spawnChild: () => {
      const spawned = spawn(executable.path, buildOpencodeChildArgs({ cwd: args.cwd }), {
        cwd: args.cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"],
      });
      child = spawned;
      readline.createInterface({ input: spawned.stdout, crlfDelay: Infinity })
        .on("line", (line) => { if (child === spawned) core.onChildLine(line); });
      // opencode logs on stderr; show it like any other plain output line.
      readline.createInterface({ input: spawned.stderr, crlfDelay: Infinity })
        .on("line", (line) => { if (child === spawned) core.onChildLine(line); });
      spawned.on("error", (err) => {
        if (child === spawned) {
          console.error(`${OPENCODE_RUNNER_ERROR_MARKER} could not start opencode: ${err.message}`);
          core.onChildExit(127);
        }
      });
      spawned.on("close", (code) => { if (child === spawned) core.onChildExit(code); });
    },
    mirrorLine: (line) => process.stdout.write(`${line}\n`),
    mirrorAppend: (text) => process.stdout.write(text),
    postActivity: (payload) => {
      if (!endpoint || typeof fetch !== "function") return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 1500);
      fetch(new URL("/api/activity/hooks", endpoint.baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.token}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).catch(() => { /* best-effort; never blocks the loop */ }).finally(() => clearTimeout(timeout));
    },
    writeSidecar: (state) => {
      try { fs.writeFileSync(paths.runnerStatePath, JSON.stringify(state)); } catch { /* adapter falls back to pane markers */ }
    },
    exit: (code) => {
      // Let stdout flush, then end the process (the pane returns to its shell).
      setTimeout(() => process.exit(code), 50);
    },
    now: () => new Date().toISOString(),
  };

  core = new OpencodeRunnerCore(io, {
    sessionName: args.sessionName,
    nodeId: process.env.OPENRIG_NODE_ID,
    generation: process.env.OPENRIG_OCCUPANT_GENERATION,
    launchId: args.launchId,
    posture: args.posture,
    cwd: args.cwd,
    model: args.model,
  }, args.sessionId, Date.now());

  createRunnerInput(process.stdin as NodeJS.ReadStream, process.stdout as NodeJS.WriteStream, (block) => core.onPaneInput(block));
  const tick = setInterval(() => core.onTick(Date.now()), 2000);
  tick.unref();
  for (const signal of ["SIGTERM", "SIGHUP"] as const) process.on(signal, () => core.shutdown(`runner received ${signal}`));
  core.start();
}

const invokedDirectly = (() => {
  try { return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
})();
if (invokedDirectly) void main();
