// The model a seat is actually running, as its runtime reports it (the spec's `model` is only
// what was requested, and is absent for seats that use the runtime's default).
//   - claude-code / codex: the newest model named in the provider transcript (bounded tail reads,
//     the same readers the model-divergence detector uses), cached per file signature because
//     inventory is polled far more often than transcripts change.
//   - agy / opencode: the `model` the seat's runner wrote to its launch-scoped sidecar.
// Anything unreadable is null: an honest unknown, never a guess.

import { readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import { getOpenRigHome } from "../openrig-compat.js";
import { readClaudeEffectiveModel, readCodexEffectiveModel } from "./model-divergence/effective-model-readers.js";

export interface EffectiveModelInput {
  runtime: string | null;
  sessionName: string | null;
  transcriptPath: string | null;
}

const MAX_MODEL_LENGTH = 200;
const MAX_CACHE_ENTRIES = 256;
const transcriptCache = new Map<string, { signature: string; model: string | null }>();

function cleanModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  if (!model || model.length > MAX_MODEL_LENGTH || /[\u0000-\u001f\u007f]/.test(model)) return null;
  return model;
}

function readTranscriptModel(runtime: "claude-code" | "codex", transcriptPath: string): string | null {
  let signature: string;
  try {
    const stat = statSync(transcriptPath);
    signature = `${runtime}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
  const cached = transcriptCache.get(transcriptPath);
  if (cached && cached.signature === signature) return cached.model;
  const model = cleanModel(runtime === "claude-code" ? readClaudeEffectiveModel(transcriptPath) : readCodexEffectiveModel(transcriptPath));
  if (transcriptCache.size >= MAX_CACHE_ENTRIES && !transcriptCache.has(transcriptPath)) transcriptCache.clear();
  transcriptCache.set(transcriptPath, { signature, model });
  return model;
}

function readRunnerSidecarModel(stateRoot: string, sessionName: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(nodePath.join(stateRoot, sessionName, "runner-state.json"), "utf-8")) as { model?: unknown };
    return cleanModel(parsed.model);
  } catch {
    return null;
  }
}

export function resolveEffectiveModel(input: EffectiveModelInput, openrigHome: string = getOpenRigHome()): string | null {
  try {
    if ((input.runtime === "claude-code" || input.runtime === "codex") && input.transcriptPath) {
      return readTranscriptModel(input.runtime, input.transcriptPath);
    }
    if ((input.runtime === "agy" || input.runtime === "opencode") && input.sessionName) {
      // A session name is a single path segment; refuse anything that could climb out of the state root.
      if (/[\\/]/.test(input.sessionName) || input.sessionName.includes("..")) return null;
      return readRunnerSidecarModel(nodePath.join(openrigHome, "state", input.runtime), input.sessionName);
    }
  } catch {
    // Reading a model must never fail an inventory read.
  }
  return null;
}
