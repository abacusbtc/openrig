// agy (Antigravity CLI) runner protocol: seat paths, sidecar state, command and
// argv construction, and the child env allowlist. Pure helpers shared by the
// pane-hosted agy-runner and the agy runtime adapter; no daemon imports, so the
// compiled runner entry stays runnable as `node <dist>/adapters/agy-runner.js`.
//
// Unlike Pi/OMP, an agy seat keeps the operator's real HOME: agy's OAuth
// subscription token lives in ~/.gemini/antigravity-cli, so isolating HOME would
// log the seat out. Conversations are stored there too and are addressable by
// id from any process, which is what makes the conversation id the resume token.

import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";

export type AgyPosture = "floor" | "auto" | "full_bypass";

export const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type AgyEffort = (typeof AGY_EFFORTS)[number];

export interface AgySeatPaths {
  seatRoot: string;
  runnerStatePath: string;
}

export function agySeatPaths(stateRoot: string, sessionName: string): AgySeatPaths {
  const seatRoot = nodePath.join(stateRoot, sessionName);
  return { seatRoot, runnerStatePath: nodePath.join(seatRoot, "runner-state.json") };
}

export const AGY_RUNNER_READY_MARKER = "[agy-runner] READY";
export const AGY_RUNNER_EXIT_MARKER = "[agy-runner] EXITED";
export const AGY_RUNNER_ERROR_MARKER = "[agy-runner] ERROR";

/** Conversation ids are UUIDs; anything else must never reach `--conversation`. */
const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isAgyConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID.test(value);
}

// ── Sidecar ──────────────────────────────────────────────────────────────────

export interface AgyRunnerState {
  ready: boolean;
  /** Launch-attempt scope: readiness polls ignore any state with another launchId. */
  launchId?: string;
  /** The agy conversation id: this runner's resume token. */
  conversationId?: string;
  /** The model agy reports running (init event), else the model the seat requested; absent when agy chose its default. */
  model?: string;
  /** True while a turn is in flight (turn sent, no `result` yet). */
  busy?: boolean;
  /** ISO time of the last completed turn. */
  lastTurnAt?: string;
  updatedAt: string;
  exited?: { code: number | null; at: string };
}

export function buildPendingAgyRunnerState(
  launchId: string,
  updatedAt: string,
  prior: AgyRunnerState | null,
  resumeConversationId?: string,
): AgyRunnerState {
  return {
    ready: false,
    launchId,
    // A resume keeps the requested id visible while the runner boots.
    conversationId: resumeConversationId ?? prior?.conversationId,
    updatedAt,
  };
}

export function parseAgyRunnerState(raw: string): AgyRunnerState | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    if (typeof state.ready !== "boolean" || typeof state.updatedAt !== "string") return null;
    return parsed as unknown as AgyRunnerState;
  } catch {
    return null;
  }
}

// ── Child environment (deny by default) ──────────────────────────────────────

const AGY_ENV_BASELINE = [
  "PATH", "HOME", "USER", "LOGNAME", "TERM", "LANG", "LC_ALL", "SHELL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
] as const;

// Managed identity and daemon locators, so agy's shell tools resolve `rig whoami`,
// `rig send` and `rig queue` as this seat instead of as an unmanaged caller.
const AGY_ENV_OPENRIG = [
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION",
  "OPENRIG_HOME", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT", "OPENRIG_SHARED_DOCS_ROOT",
] as const;

export function buildAgyChildEnv(
  source: Record<string, string | undefined>,
  opts: { sessionName: string; nodeId?: string; openrigHome?: string; openrigUrl?: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [...AGY_ENV_BASELINE, ...AGY_ENV_OPENRIG]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.OPENRIG_SESSION_NAME = opts.sessionName;
  env.OPENRIG_RUNTIME = "agy";
  if (opts.nodeId) env.OPENRIG_NODE_ID = opts.nodeId;
  if (opts.openrigHome) env.OPENRIG_HOME = opts.openrigHome;
  if (opts.openrigUrl) env.OPENRIG_URL = opts.openrigUrl;
  return env;
}

// ── Command construction ─────────────────────────────────────────────────────

export interface AgyRunnerLaunchOpts {
  runnerEntryPath: string;
  sessionName: string;
  stateRoot: string;
  cwd: string;
  launchId: string;
  posture: AgyPosture;
  model?: string;
  effort?: string;
  /** Exact conversation to resume; becomes `--conversation <id>` on the agy child. */
  conversationId?: string;
}

/** The command typed into the seat's tmux pane. The runner owns everything past
 *  this boundary (agy spawn, env allowlist, stream-json, mirror, sidecar). */
export function buildAgyRunnerCommand(opts: AgyRunnerLaunchOpts): string {
  const parts = [
    "node",
    shellQuote(opts.runnerEntryPath),
    "--session-name", shellQuote(opts.sessionName),
    "--state-root", shellQuote(opts.stateRoot),
    "--cwd", shellQuote(opts.cwd),
    "--launch-id", shellQuote(opts.launchId),
    "--posture", opts.posture,
  ];
  if (opts.model?.trim()) parts.push("--model", shellQuote(opts.model.trim()));
  if (opts.effort?.trim()) parts.push("--effort", shellQuote(opts.effort.trim()));
  if (opts.conversationId) parts.push("--conversation", shellQuote(opts.conversationId));
  return parts.join(" ");
}

/** Argv for the `agy` child the RUNNER spawns (argv-style, no shell). The empty
 *  `--print=` is required: a bare `--print` swallows the next flag as its prompt. */
export function buildAgyChildArgs(opts: {
  posture: AgyPosture;
  model?: string;
  effort?: string;
  conversationId?: string;
}): string[] {
  const args = ["--print=", "--input-format", "stream-json", "--output-format", "stream-json"];
  // Headless agy cannot prompt: "floor" leaves its request-review default, so tools
  // outside permissions.allow are auto-denied and reported in `denied_actions`.
  if (opts.posture === "full_bypass") args.push("--dangerously-skip-permissions");
  else if (opts.posture === "auto") args.push("--mode", "auto");
  if (opts.model?.trim()) args.push("--model", opts.model.trim());
  if (opts.effort?.trim()) args.push("--effort", opts.effort.trim());
  if (opts.conversationId) args.push("--conversation", opts.conversationId);
  return args;
}

/** One stream-json input line for a user turn. */
export function encodeAgyUserMessage(text: string): string {
  return `${JSON.stringify({ event: "user", message: { content: text } })}\n`;
}

// ── Interactive mode ─────────────────────────────────────────────────────────

/** How an agy seat runs: "headless" drives agy over stream-json through the runner (default);
 *  "interactive" runs agy's own console in the pane, so the operator can attach, approve a tool
 *  request in place and choose "always allow" (agy persists that to its settings.json). */
export type AgyMode = "headless" | "interactive";

/** OPENRIG_AGY_MODE=interactive opts every agy seat into the console; anything else is headless. */
export function resolveAgyMode(env: NodeJS.ProcessEnv): AgyMode {
  return env.OPENRIG_AGY_MODE?.trim().toLowerCase() === "interactive" ? "interactive" : "headless";
}

export interface AgyInteractiveLaunchOpts {
  posture: AgyPosture;
  model?: string;
  effort?: string;
  /** Exact conversation to resume; becomes `--conversation <id>`. */
  conversationId?: string;
}

/** The command typed into the seat's pane for an interactive seat: agy itself, no runner. Unlike
 *  the headless child it can ask, so only full_bypass changes the permission flag. */
export function buildAgyInteractiveCommand(opts: AgyInteractiveLaunchOpts): string {
  const parts = ["agy"];
  if (opts.posture === "full_bypass") parts.push("--dangerously-skip-permissions");
  else if (opts.posture === "auto") parts.push("--mode", "auto");
  if (opts.model?.trim()) parts.push("--model", shellQuote(opts.model.trim()));
  if (opts.effort?.trim()) parts.push("--effort", shellQuote(opts.effort.trim()));
  if (opts.conversationId) parts.push("--conversation", shellQuote(opts.conversationId));
  return parts.join(" ");
}

/** Pane text that says agy is up and waiting for input, or stopped on its folder-trust gate. */
export const AGY_INTERACTIVE_READY_TEXT = "? for shortcuts";
export const AGY_INTERACTIVE_TRUST_TEXT = "Do you trust the contents of this project?";
