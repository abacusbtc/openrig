// opencode runner protocol: seat paths, sidecar state, command and argv
// construction, the permission posture config, the child env allowlist and the
// ACP (Agent Client Protocol) JSON-RPC encoders. Pure helpers shared by the
// pane-hosted opencode-runner and the opencode runtime adapter; no daemon
// imports, so the compiled runner entry stays runnable as
// `node <dist>/adapters/opencode-runner.js`.
//
// Like agy, an opencode seat keeps the operator's real HOME and XDG dirs:
// opencode's provider logins (OAuth subscription tokens, API keys) live in
// ~/.local/share/opencode/auth.json, and sessions are stored beside them, so a
// session id is addressable from any later process. That is what makes the ACP
// session id (`ses_...`) the resume token.

import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";

/**
 * floor        every edit and shell command asks the seat's pane (denied on timeout)
 * auto         edits are allowed; shell commands ask the pane (denied on timeout)
 * full_bypass  opencode's own default: nothing asks
 */
export type OpencodePosture = "floor" | "auto" | "full_bypass";

export interface OpencodeSeatPaths {
  seatRoot: string;
  runnerStatePath: string;
}

export function opencodeSeatPaths(stateRoot: string, sessionName: string): OpencodeSeatPaths {
  const seatRoot = nodePath.join(stateRoot, sessionName);
  return { seatRoot, runnerStatePath: nodePath.join(seatRoot, "runner-state.json") };
}

export const OPENCODE_RUNNER_READY_MARKER = "[opencode-runner] READY";
export const OPENCODE_RUNNER_EXIT_MARKER = "[opencode-runner] EXITED";
export const OPENCODE_RUNNER_ERROR_MARKER = "[opencode-runner] ERROR";

/** ACP session ids look like `ses_eb49b1749ffeC6daza8UI6Qof5`; anything else must never reach `session/resume`. */
const SESSION_ID = /^ses_[A-Za-z0-9]{8,64}$/;
export function isOpencodeSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID.test(value);
}

/** opencode model ids are `<provider>/<model>`; the model segment may contain further slashes (openrouter). */
const MODEL_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:/@+-]+$/;
export function isOpencodeModelId(value: unknown): value is string {
  return typeof value === "string" && MODEL_ID.test(value);
}

// ── Sidecar ──────────────────────────────────────────────────────────────────

export interface OpencodeRunnerState {
  ready: boolean;
  /** Launch-attempt scope: readiness polls ignore any state with another launchId. */
  launchId?: string;
  /** The ACP session id: this runner's resume token. */
  sessionId?: string;
  /** The model opencode reports as the session's current model (configOptions), else the requested one. */
  model?: string;
  /** True while a prompt is in flight. */
  busy?: boolean;
  /** True while a permission request waits on the pane. */
  awaitingPermission?: boolean;
  /** ISO time of the last completed turn. */
  lastTurnAt?: string;
  updatedAt: string;
  exited?: { code: number | null; at: string };
}

export function buildPendingOpencodeRunnerState(
  launchId: string,
  updatedAt: string,
  prior: OpencodeRunnerState | null,
  resumeSessionId?: string,
): OpencodeRunnerState {
  return {
    ready: false,
    launchId,
    // A resume keeps the requested id visible while the runner boots.
    sessionId: resumeSessionId ?? prior?.sessionId,
    updatedAt,
  };
}

export function parseOpencodeRunnerState(raw: string): OpencodeRunnerState | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const state = parsed as Record<string, unknown>;
    if (typeof state.ready !== "boolean" || typeof state.updatedAt !== "string") return null;
    return parsed as unknown as OpencodeRunnerState;
  } catch {
    return null;
  }
}

// ── Child environment (deny by default) ──────────────────────────────────────

const OPENCODE_ENV_BASELINE = [
  "PATH", "HOME", "USER", "LOGNAME", "TERM", "LANG", "LC_ALL", "SHELL", "TMPDIR",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
] as const;

// Managed identity and daemon locators, so opencode's shell tools resolve `rig whoami`,
// `rig send` and `rig queue` as this seat instead of as an unmanaged caller.
const OPENCODE_ENV_OPENRIG = [
  "OPENRIG_NODE_ID", "OPENRIG_SESSION_NAME", "OPENRIG_RUNTIME", "OPENRIG_OCCUPANT_GENERATION",
  "OPENRIG_HOME", "OPENRIG_URL", "OPENRIG_HOST", "OPENRIG_PORT", "OPENRIG_SHARED_DOCS_ROOT",
] as const;

/** Operators who authenticate a provider by API key (not `opencode auth login`) name the variables here. */
export const OPENCODE_ENV_PASSTHROUGH_VAR = "OPENRIG_OPENCODE_ENV_PASSTHROUGH";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildOpencodeChildEnv(
  source: Record<string, string | undefined>,
  opts: { sessionName: string; posture: OpencodePosture; nodeId?: string; openrigHome?: string; openrigUrl?: string; operatorPermission?: unknown },
): Record<string, string> {
  const env: Record<string, string> = {};
  const passthrough = (source[OPENCODE_ENV_PASSTHROUGH_VAR] ?? "")
    .split(",").map((name) => name.trim()).filter((name) => ENV_NAME.test(name));
  for (const name of [...OPENCODE_ENV_BASELINE, ...OPENCODE_ENV_OPENRIG, ...passthrough]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  env.OPENRIG_SESSION_NAME = opts.sessionName;
  env.OPENRIG_RUNTIME = "opencode";
  if (opts.nodeId) env.OPENRIG_NODE_ID = opts.nodeId;
  if (opts.openrigHome) env.OPENRIG_HOME = opts.openrigHome;
  if (opts.openrigUrl) env.OPENRIG_URL = opts.openrigUrl;
  // The posture rides inline config, which opencode layers over the operator's own config files.
  const config = buildOpencodePostureConfig(opts.posture, opts.operatorPermission);
  if (config) env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  return env;
}

/** The inline opencode config enforcing a posture, or null when opencode's defaults are the posture. */
export type OpencodePermissionValue = string | Record<string, string>;

/** Drops // and block comments and trailing commas from JSONC, leaving string contents alone. */
export function stripJsonc(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += ch;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** The `permission` block of the operator's own opencode config (`opencode.jsonc`, then `opencode.json`,
 *  under $XDG_CONFIG_HOME or ~/.config), or undefined when there is none or it does not parse. A broken
 *  file never loosens a seat: the posture then simply has no operator rules. */
export function readOperatorOpencodePermission(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string | null,
): unknown {
  const base = env.XDG_CONFIG_HOME || (env.HOME ? nodePath.join(env.HOME, ".config") : undefined);
  if (!base) return undefined;
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const text = readFile(nodePath.join(base, "opencode", name));
    if (text === null) continue;
    try {
      return (JSON.parse(stripJsonc(text)) as { permission?: unknown }).permission;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The pattern rules the operator saved under `permission.<tool>` in their own opencode config. Only
 *  object-form entries count: a bare string is the operator's blanket default, which the posture
 *  replaces. */
export function operatorPermissionRules(operatorPermission: unknown, tool: "edit" | "bash"): Record<string, string> {
  const entry = (operatorPermission as Record<string, unknown> | null | undefined)?.[tool];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return {};
  const rules: Record<string, string> = {};
  for (const [pattern, action] of Object.entries(entry)) {
    if (pattern !== "*" && (action === "allow" || action === "ask" || action === "deny")) rules[pattern] = action;
  }
  return rules;
}

/** A blanket "ask" as a pattern rule, then the operator's saved rules. opencode lets the last matching
 *  rule win, so the catch-all goes first and an approval the operator saved still applies; a bare
 *  "ask" string would replace those rules outright. */
function askWithOperatorRules(rules: Record<string, string>): Record<string, string> {
  return { "*": "ask", ...rules };
}

export function buildOpencodePostureConfig(
  posture: OpencodePosture,
  operatorPermission?: unknown,
): { permission: Record<string, OpencodePermissionValue> } | null {
  if (posture === "floor") {
    return { permission: {
      edit: askWithOperatorRules(operatorPermissionRules(operatorPermission, "edit")),
      bash: askWithOperatorRules(operatorPermissionRules(operatorPermission, "bash")),
    } };
  }
  if (posture === "auto") {
    return { permission: { edit: "allow", bash: askWithOperatorRules(operatorPermissionRules(operatorPermission, "bash")) } };
  }
  return null;
}

// ── Command construction ─────────────────────────────────────────────────────

export interface OpencodeRunnerLaunchOpts {
  runnerEntryPath: string;
  sessionName: string;
  stateRoot: string;
  cwd: string;
  launchId: string;
  posture: OpencodePosture;
  /** `<provider>/<model>`, applied through ACP `session/set_config_option`. */
  model?: string;
  /** Exact ACP session to resume; becomes `session/resume` in the runner. */
  sessionId?: string;
}

/** The command typed into the seat's tmux pane. The runner owns everything past
 *  this boundary (opencode spawn, env allowlist, ACP, mirror, sidecar). */
export function buildOpencodeRunnerCommand(opts: OpencodeRunnerLaunchOpts): string {
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
  if (opts.sessionId) parts.push("--session", shellQuote(opts.sessionId));
  return parts.join(" ");
}

/** Argv for the `opencode` child the RUNNER spawns (argv-style, no shell). */
export function buildOpencodeChildArgs(opts: { cwd: string }): string[] {
  return ["acp", "--cwd", opts.cwd];
}

// ── ACP JSON-RPC encoding ────────────────────────────────────────────────────

export const ACP_PROTOCOL_VERSION = 1;

export function encodeAcpRequest(id: number, method: string, params: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

export function encodeAcpNotification(method: string, params: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`;
}

export function encodeAcpResult(id: number | string, result: Record<string, unknown>): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

export function encodeAcpError(id: number | string, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`;
}

/** The text prompt for one user turn. */
export function acpTextPrompt(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}
