// The pane-hosted agy-runner (compiled entry in the daemon dist).
//
// It makes an agy (Antigravity CLI) seat behave like a normal OpenRig tmux seat
// while everything underneath stays structured stream-json:
//
//   pane stdin (rig send / human typing) ──▶ one {"event":"user"} turn at a time
//   agy stream-json events (typed NDJSON) ──▶ (a) human-readable pane mirror
//                                              (b) activity + session_identity
//                                                  POSTs to the daemon
//                                              (c) runner-state.json sidecar
//
// Activity and session identity derive only from agy's typed events, never from
// pane scraping. The agy child gets a deny-by-default env allowlist. A dead agy
// prints the EXIT/ERROR marker and records `exited` in the sidecar, never a
// silently frozen pane.
//
// agy facts this relies on (verified against agy 1.4.0):
//   - `init` (with the conversation id) is emitted at startup, before any input,
//     so it is the readiness signal.
//   - One process serves many turns and keeps context; each turn ends with `result`.
//   - There is no in-band cancel event. SIGINT aborts the turn and exits the process
//     (result status ERROR, "interrupted"), and `--conversation <id>` resumes the same
//     history in a new process, so an interrupt is SIGINT followed by a respawn.
//   - Headless agy cannot prompt for permissions. Tools outside permissions.allow are
//     auto-denied and listed in `result.denied_actions`; the runner surfaces them.
//
// Only node builtins and local runner helpers are imported so the compiled entry
// stays runnable as `node <dist>/adapters/agy-runner.js` with no daemon deps.

import fs from "node:fs";
import nodePath from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import readline from "node:readline";
import { createRunnerInput, resolveActivityEndpoint, resolveRuntimeExecutable } from "./pi-runner.js";
import {
  AGY_EFFORTS, AGY_RUNNER_ERROR_MARKER, AGY_RUNNER_EXIT_MARKER, AGY_RUNNER_READY_MARKER,
  agySeatPaths, buildAgyChildArgs, buildAgyChildEnv, buildPendingAgyRunnerState, encodeAgyUserMessage,
  isAgyConversationId, parseAgyRunnerState,
  type AgyPosture, type AgyRunnerState,
} from "./agy-runner-protocol.js";

// ── agy event → mirror + activity mapping (pure, hermetically testable) ──────

export interface AgyMapped {
  /** Lines to print to the pane (already human-readable). */
  mirrorLines: string[];
  /** Raw text to append to the current mirror line (streamed deltas). */
  mirrorAppend?: string;
  /** Activity POST payload, when the event maps to one. */
  activity?: { hookEvent: string; subtype: string | null };
  /** A tool step finished or began: lets the core close an open streamed line first. */
  closesLine?: boolean;
}

export interface AgyDeniedAction {
  action: string;
  display_name?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** One-line summary of a tool call's arguments for the pane (capped, no newlines). */
export function summarizeToolParams(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const record = params as Record<string, unknown>;
  const preferred = ["CommandLine", "command", "AbsolutePath", "TargetFile", "Url", "Query", "SearchPath", "DirectoryPath"];
  const key = preferred.find((k) => typeof record[k] === "string")
    ?? Object.keys(record).find((k) => typeof record[k] === "string");
  if (!key) return "";
  const oneLine = String(record[key]).replace(/\s+/g, " ").trim();
  return oneLine.length > 100 ? `${oneLine.slice(0, 97)}...` : oneLine;
}

export function mapAgyStepUpdate(step: Record<string, unknown>): AgyMapped {
  const type = str(step.step_type) ?? "";
  const state = str(step.state) ?? "";
  switch (type) {
    case "agent_response": {
      const delta = str(step.text_delta);
      return delta ? { mirrorLines: [], mirrorAppend: delta } : { mirrorLines: [] };
    }
    case "tool": {
      const name = str(step.tool_name) ?? "tool";
      const info = (step.tool_info ?? {}) as Record<string, unknown>;
      const summary = summarizeToolParams(info.parameters);
      if (state === "ACTIVE") {
        return {
          mirrorLines: [`  ⚙ ${name}${summary ? ` ${summary}` : ""} …`],
          activity: { hookEvent: "PreToolUse", subtype: name },
          closesLine: true,
        };
      }
      if (state === "DONE") return { mirrorLines: [`  ⚙ ${name} done`], closesLine: true };
      if (state === "ERROR" || state === "FAILED" || state === "CANCELLED") {
        return { mirrorLines: [`  ⚙ ${name} ${state === "CANCELLED" ? "cancelled" : "FAILED"}`], closesLine: true };
      }
      return { mirrorLines: [] };
    }
    default:
      // user_input, system_message and any step type this runner does not know.
      return { mirrorLines: [] };
  }
}

/** The pane notice for tools agy auto-denied in headless mode. */
export function deniedActionsNotice(denied: AgyDeniedAction[], posture: AgyPosture, at?: string): string[] {
  if (denied.length === 0) return [];
  const when = at ? ` (turn ended ${at})` : "";
  const lines = denied.slice(0, 5).map((d) => `${AGY_RUNNER_ERROR_MARKER} denied ${d.action}${d.display_name ? `: ${d.display_name}` : ""}${when}`);
  if (denied.length > 5) lines.push(`${AGY_RUNNER_ERROR_MARKER} ... and ${denied.length - 5} more denied${when}`);
  if (posture === "full_bypass") {
    lines.push(`${AGY_RUNNER_ERROR_MARKER} permissions were bypassed yet agy still denied these; check agy's own settings`);
    return lines;
  }
  // Name the rule that would allow the first denial. A command rule names the binary only.
  const first = denied[0];
  const target = first.display_name ? (first.action === "command" ? first.display_name.trim().split(/\s+/)[0] : first.display_name) : undefined;
  const rule = target ? `${first.action}(${target})` : `${first.action}(<target>)`;
  lines.push(`${AGY_RUNNER_ERROR_MARKER} headless agy cannot ask. To allow the first of these, add "${rule}" to permissions.allow in ~/.gemini/antigravity-cli/settings.json (the file is shared by every agy seat, so keep rules narrow); or launch this seat with a wider permission posture`);
  return lines;
}

/** Does `cwd` sit inside one of agy's trustedWorkspaces? Untrusted workspaces get tools denied. */
export function agyWorkspaceTrustNotice(settingsRaw: string | null, cwd: string): string | undefined {
  if (settingsRaw === null) return undefined;
  let trusted: unknown;
  try { trusted = (JSON.parse(settingsRaw) as Record<string, unknown>).trustedWorkspaces; } catch { return undefined; }
  if (!Array.isArray(trusted)) return undefined;
  const target = nodePath.resolve(cwd);
  const inside = trusted.some((entry) => {
    if (typeof entry !== "string") return false;
    const root = nodePath.resolve(entry);
    return target === root || target.startsWith(root.endsWith(nodePath.sep) ? root : root + nodePath.sep);
  });
  return inside ? undefined
    : `${AGY_RUNNER_ERROR_MARKER} ${cwd} is not in agy's trustedWorkspaces (~/.gemini/antigravity-cli/settings.json); agy may deny reads and commands there until it is added`;
}

// ── The runner core (injected effects; owns the state machine) ──────────────

export interface AgyRunnerIo {
  /** Write one NDJSON line to the live agy child's stdin. */
  sendToChild(line: string): void;
  /** Signal the live agy child. */
  signalChild(signal: NodeJS.Signals): void;
  /** Start a new agy child (resuming `conversationId` when given). */
  spawnChild(conversationId?: string): void;
  mirrorLine(line: string): void;
  mirrorAppend(text: string): void;
  postActivity(payload: Record<string, unknown>): void | Promise<Record<string, unknown> | null>;
  writeSidecar(state: AgyRunnerState): void;
  /** End the runner process. */
  exit(code: number): void;
  now(): string;
}

export type AgyPhase = "starting" | "idle" | "busy" | "interrupting" | "exited";

export interface AgyRunnerIdentity {
  sessionName: string;
  nodeId?: string;
  generation?: string;
  launchId: string;
  posture: AgyPosture;
  /** The model requested at launch, reported when agy's init event does not name one. */
  model?: string;
}

export const AGY_MAX_QUEUED_TURNS = 100;
export const AGY_INIT_TIMEOUT_MS = 90_000;
/** An interrupt that agy has not honoured by exiting escalates: SIGTERM after this long, SIGKILL after the next. */
export const AGY_INTERRUPT_TERM_MS = 5_000;
export const AGY_INTERRUPT_KILL_MS = 10_000;

export class AgyRunnerCore {
  phase: AgyPhase = "starting";
  conversationId: string | undefined;
  model: string | undefined;
  private ready = false;
  private everReady = false;
  private lineOpen = false;
  private streamedThisTurn = false;
  private queue: string[] = [];
  private startedAtMs: number;
  private clockMs: number;
  private lastTurnAt: string | undefined;
  private turnDenied: AgyDeniedAction[] = [];
  private interruptedAtMs = 0;
  private escalation: 0 | 1 | 2 = 0;

  constructor(
    private readonly io: AgyRunnerIo,
    private readonly identity: AgyRunnerIdentity,
    resumeConversationId: string | undefined,
    nowMs: number,
  ) {
    this.conversationId = resumeConversationId;
    this.startedAtMs = nowMs;
    this.clockMs = nowMs;
  }

  get queued(): number { return this.queue.length; }

  /** Begin: spawn the first child. */
  start(): void {
    this.io.spawnChild(this.conversationId);
  }

  /** Pane input: a message for agy, or the /abort control. */
  onPaneInput(block: string): void {
    const text = block.trim();
    if (!text) return;
    if (text === "/abort") { this.interrupt(); return; }
    if (this.phase === "exited") return;
    if (this.queue.length >= AGY_MAX_QUEUED_TURNS) {
      this.closeLine();
      this.io.mirrorLine(`${AGY_RUNNER_ERROR_MARKER} input queue is full (${AGY_MAX_QUEUED_TURNS}); message dropped`);
      return;
    }
    this.queue.push(text);
    if (this.phase === "busy" || this.phase === "interrupting") {
      this.closeLine();
      this.io.mirrorLine(`[agy-runner] queued (${this.queue.length} waiting)`);
    }
    this.dispatchNext();
  }

  /** One decoded stdout line from the agy child. */
  onChildLine(rawLine: string): void {
    if (this.phase === "exited") return;
    const line = stripVTControlCharacters(rawLine).trim();
    if (!line) return;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      event = parsed as Record<string, unknown>;
    } catch {
      // agy writes plain diagnostics ("error: ...", "jetski: ...", "warning: ...") beside the JSON.
      this.closeLine();
      this.io.mirrorLine(`[agy] ${line}`);
      return;
    }
    switch (event.event) {
      case "init": this.onInit(event); break;
      case "step_update": this.onStep((event.step_update ?? {}) as Record<string, unknown>); break;
      case "result": this.onResult((event.result ?? {}) as Record<string, unknown>); break;
      default: break;
    }
  }

  /** The agy child exited (or was killed). */
  onChildExit(code: number | null): void {
    if (this.phase === "exited") return;
    if (this.phase === "interrupting") {
      // Expected: SIGINT ends the process. Resume the same conversation.
      this.closeLine();
      this.io.mirrorLine("[agy-runner] interrupted; restarting agy on the same conversation");
      this.turnDenied = [];
      this.phase = "starting";
      this.startedAtMs = this.clockMs;
      this.io.postActivity(this.activityPayload("Stop", "interrupted"));
      this.writeSidecar({ busy: false });
      this.io.spawnChild(this.conversationId);
      return;
    }
    this.fail(code, code === 0 ? "agy exited" : `agy exited with code ${code ?? "unknown"}`);
  }

  /** Called periodically: bounds how long the first `init` may take. */
  onTick(nowMs: number): void {
    this.clockMs = nowMs;
    if (this.phase === "interrupting") {
      // SIGINT is a request. agy (or a tool it is blocked in) can ignore it, which would wedge the seat
      // in "interrupting" forever, so escalate to SIGTERM and then SIGKILL until the process is gone.
      const waited = nowMs - this.interruptedAtMs;
      if (this.escalation < 2 && waited >= AGY_INTERRUPT_KILL_MS) {
        this.escalation = 2;
        this.closeLine();
        this.io.mirrorLine("[agy-runner] agy ignored SIGTERM; killing it");
        this.io.signalChild("SIGKILL");
      } else if (this.escalation < 1 && waited >= AGY_INTERRUPT_TERM_MS) {
        this.escalation = 1;
        this.closeLine();
        this.io.mirrorLine("[agy-runner] agy did not stop on SIGINT; sending SIGTERM");
        this.io.signalChild("SIGTERM");
      }
    }
    if (this.phase === "starting" && nowMs - this.startedAtMs > AGY_INIT_TIMEOUT_MS) {
      this.io.signalChild("SIGTERM");
      this.fail(null, `agy did not report init within ${AGY_INIT_TIMEOUT_MS / 1000}s`);
    }
  }

  /** The runner itself was asked to stop (SIGTERM/SIGHUP). */
  shutdown(reason: string): void {
    if (this.phase === "exited") return;
    this.io.signalChild("SIGTERM");
    this.fail(null, reason, 0);
  }

  // ── transitions ────────────────────────────────────────────────────────────

  private onInit(event: Record<string, unknown>): void {
    const id = str(event.conversation_id);
    if (!isAgyConversationId(id)) {
      this.fail(null, "agy init carried no valid conversation id");
      return;
    }
    if (this.conversationId && this.conversationId !== id) {
      // A resume that came up on a different conversation started a different history.
      this.io.signalChild("SIGTERM");
      this.fail(null, `agy resumed conversation ${id} but ${this.conversationId} was requested`);
      return;
    }
    this.conversationId = id;
    const init = event.init;
    this.model = (typeof init === "object" && init !== null ? str((init as Record<string, unknown>).model) : undefined) ?? this.identity.model;
    this.ready = true;
    this.phase = "idle";
    this.writeSidecar({ busy: false });
    this.closeLine();
    this.io.mirrorLine(this.everReady
      ? `[agy-runner] agy restarted on conversation ${id}`
      : `${AGY_RUNNER_READY_MARKER} conversation ${id}`);
    this.everReady = true;
    this.postSessionIdentity();
    this.dispatchNext();
  }

  private dispatchNext(): void {
    if (this.phase !== "idle" || this.queue.length === 0) return;
    const text = this.queue.shift()!;
    this.phase = "busy";
    this.streamedThisTurn = false;
    this.turnDenied = [];
    this.writeSidecar({ busy: true });
    this.io.postActivity(this.activityPayload("active", "turn_start"));
    this.io.mirrorLine(`> ${text.split("\n")[0]!.slice(0, 200)}${text.includes("\n") || text.length > 200 ? " …" : ""}`);
    this.io.sendToChild(encodeAgyUserMessage(text));
  }

  private onStep(step: Record<string, unknown>): void {
    const mapped = mapAgyStepUpdate(step);
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

  private onResult(result: Record<string, unknown>): void {
    this.closeLine();
    const status = str(result.status);
    const error = str(result.error);
    const denied = Array.isArray(result.denied_actions)
      ? (result.denied_actions as unknown[]).filter((d): d is AgyDeniedAction => !!d && typeof d === "object" && typeof (d as AgyDeniedAction).action === "string")
      : [];
    if (this.phase === "interrupting") {
      // The interrupt's own result; the exit handler restarts the child.
      return;
    }
    if (this.phase !== "busy") {
      // No turn in flight (for example agy reporting its stdin closing): not a turn
      // outcome, so no Stop activity and no queue dispatch; just keep the error visible.
      if (status === "ERROR" && error) this.io.mirrorLine(`[agy] ${error}`);
      return;
    }
    for (const line of deniedActionsNotice(denied, this.identity.posture, this.io.now())) this.io.mirrorLine(line);
    if (status === "ERROR") {
      this.io.mirrorLine(`${AGY_RUNNER_ERROR_MARKER} turn failed${error ? `: ${error}` : ""}`);
    } else if (!this.streamedThisTurn && typeof result.response === "string" && result.response.trim()) {
      // A turn whose text never streamed still shows its answer.
      this.io.mirrorLine(result.response.trimEnd());
    }
    this.lastTurnAt = this.io.now();
    this.phase = "idle";
    this.writeSidecar({ busy: false, lastTurnAt: this.lastTurnAt });
    this.io.postActivity(this.activityPayload("Stop", "turn_end"));
    this.dispatchNext();
  }

  private interrupt(): void {
    if (this.phase !== "busy") {
      this.closeLine();
      this.io.mirrorLine(this.phase === "starting" ? "[agy-runner] agy is still starting; nothing to interrupt"
        : this.phase === "interrupting" ? "[agy-runner] already interrupting" : "[agy-runner] nothing to interrupt");
      return;
    }
    this.closeLine();
    this.io.mirrorLine("[agy-runner] interrupting the current turn");
    this.phase = "interrupting";
    this.interruptedAtMs = this.clockMs;
    this.escalation = 0;
    this.io.signalChild("SIGINT");
  }

  private fail(code: number | null, message: string, exitCode = 1): void {
    this.phase = "exited";
    this.ready = false;
    this.closeLine();
    this.io.mirrorLine(`${exitCode === 0 ? AGY_RUNNER_EXIT_MARKER : AGY_RUNNER_ERROR_MARKER} ${message}`);
    if (exitCode !== 0) this.io.mirrorLine(AGY_RUNNER_EXIT_MARKER);
    this.io.writeSidecar({
      ready: false,
      launchId: this.identity.launchId,
      conversationId: this.conversationId,
      model: this.model,
      busy: false,
      lastTurnAt: this.lastTurnAt,
      updatedAt: this.io.now(),
      exited: { code, at: this.io.now() },
    });
    this.io.postActivity(this.activityPayload("Stop", "agy_exited"));
    this.io.exit(exitCode);
  }

  // ── helpers ────────────────────────────────────────────────────────────────

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
      runtime: "agy",
      generation: this.identity.generation ?? null,
      hookEvent: "SessionStart",
      sessionId: this.conversationId ?? "unknown",
      sessionFile: null,
      occurredAt: this.io.now(),
    });
  }

  private activityPayload(hookEvent: string, subtype: string | null): Record<string, unknown> {
    return {
      sessionName: this.identity.sessionName,
      nodeId: this.identity.nodeId ?? null,
      generation: this.identity.generation ?? null,
      runtime: "agy",
      hookEvent,
      subtype,
      occurredAt: this.io.now(),
    };
  }

  private writeSidecar(patch: Partial<AgyRunnerState>): void {
    this.io.writeSidecar({
      ready: this.ready,
      launchId: this.identity.launchId,
      conversationId: this.conversationId,
      model: this.model,
      lastTurnAt: this.lastTurnAt,
      updatedAt: this.io.now(),
      ...patch,
    });
  }
}

// ── CLI entry ────────────────────────────────────────────────────────────────

export interface AgyRunnerArgs {
  sessionName: string;
  stateRoot: string;
  cwd: string;
  launchId: string;
  posture: AgyPosture;
  model?: string;
  effort?: string;
  conversationId?: string;
}

export function parseAgyRunnerArgs(argv: string[]): AgyRunnerArgs {
  const args: Partial<AgyRunnerArgs> = {};
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
      case "--model": args.model = next(); break;
      case "--effort": {
        const effort = next();
        if (!(AGY_EFFORTS as readonly string[]).includes(effort)) throw new Error(`unsupported effort: ${effort} (expected ${AGY_EFFORTS.join("|")})`);
        args.effort = effort;
        break;
      }
      case "--conversation": {
        const id = next();
        if (!isAgyConversationId(id)) throw new Error(`--conversation must be a conversation id (UUID), got: ${id}`);
        args.conversationId = id;
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
  return args as AgyRunnerArgs;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let args: AgyRunnerArgs;
  try {
    args = parseAgyRunnerArgs(argv);
  } catch (err) {
    console.error(`${AGY_RUNNER_ERROR_MARKER} ${(err as Error).message}`);
    process.exitCode = 2;
    return;
  }

  const paths = agySeatPaths(args.stateRoot, args.sessionName);
  fs.mkdirSync(paths.seatRoot, { recursive: true });

  // Launch-attempt scoping: stamp a pending record before anything else.
  let prior: AgyRunnerState | null = null;
  try { prior = parseAgyRunnerState(fs.readFileSync(paths.runnerStatePath, "utf8")); } catch { /* absent */ }
  try {
    fs.writeFileSync(paths.runnerStatePath, JSON.stringify(
      buildPendingAgyRunnerState(args.launchId, new Date().toISOString(), prior, args.conversationId)));
  } catch { /* best-effort; the adapter pre-writes an equivalent pending record */ }

  const executable = resolveRuntimeExecutable("agy", process.env);
  if (!executable.ok) {
    console.error(`${AGY_RUNNER_ERROR_MARKER} ${executable.error}`);
    try {
      fs.writeFileSync(paths.runnerStatePath, JSON.stringify({
        ready: false, launchId: args.launchId, updatedAt: new Date().toISOString(),
        exited: { code: 127, at: new Date().toISOString() },
      } satisfies AgyRunnerState));
    } catch { /* best-effort */ }
    process.exitCode = 127;
    return;
  }

  const endpoint = resolveActivityEndpoint(process.env);
  const childEnv = buildAgyChildEnv(process.env as Record<string, string | undefined>, {
    sessionName: args.sessionName,
    nodeId: process.env.OPENRIG_NODE_ID,
    openrigHome: process.env.OPENRIG_HOME,
    openrigUrl: endpoint?.baseUrl ?? process.env.OPENRIG_URL,
  });

  let settingsRaw: string | null = null;
  try {
    settingsRaw = fs.readFileSync(nodePath.join(process.env.HOME ?? "", ".gemini", "antigravity-cli", "settings.json"), "utf8");
  } catch { /* no agy settings yet */ }
  const trustNotice = agyWorkspaceTrustNotice(settingsRaw, args.cwd);
  console.log(`[agy-runner] seat ${args.sessionName}: posture ${args.posture}, cwd ${args.cwd}`);
  if (trustNotice) console.log(trustNotice);

  let child: ChildProcessWithoutNullStreams | null = null;
  let core: AgyRunnerCore;

  const io: AgyRunnerIo = {
    sendToChild: (line) => {
      try { child?.stdin.write(line); } catch { /* the exit handler reports */ }
    },
    signalChild: (signal) => {
      try { child?.kill(signal); } catch { /* already gone */ }
    },
    spawnChild: (conversationId) => {
      const childArgs = buildAgyChildArgs({
        posture: args.posture, model: args.model, effort: args.effort, conversationId,
      });
      const spawned = spawn(executable.path, childArgs, { cwd: args.cwd, env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
      child = spawned;
      const lines = readline.createInterface({ input: spawned.stdout, crlfDelay: Infinity });
      lines.on("line", (line) => { if (child === spawned) core.onChildLine(line); });
      // agy writes diagnostics on stderr too; treat them like plain output lines.
      readline.createInterface({ input: spawned.stderr, crlfDelay: Infinity })
        .on("line", (line) => { if (child === spawned) core.onChildLine(line); });
      spawned.on("error", (err) => {
        if (child === spawned) {
          console.error(`${AGY_RUNNER_ERROR_MARKER} could not start agy: ${err.message}`);
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

  core = new AgyRunnerCore(io, {
    sessionName: args.sessionName,
    nodeId: process.env.OPENRIG_NODE_ID,
    generation: process.env.OPENRIG_OCCUPANT_GENERATION,
    launchId: args.launchId,
    posture: args.posture,
    model: args.model,
  }, args.conversationId, Date.now());

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
