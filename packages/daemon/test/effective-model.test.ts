import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveEffectiveModel } from "../src/domain/effective-model.js";

let home: string;
beforeEach(() => { home = mkdtempSync(nodePath.join(tmpdir(), "effective-model-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function sidecar(runtime: "agy" | "opencode", session: string, body: unknown): void {
  const dir = nodePath.join(home, "state", runtime, session);
  mkdirSync(dir, { recursive: true });
  writeFileSync(nodePath.join(dir, "runner-state.json"), typeof body === "string" ? body : JSON.stringify(body));
}

function claudeTranscript(name: string, ...models: string[]): string {
  const path = nodePath.join(home, name);
  writeFileSync(path, models.map((model) => JSON.stringify({ type: "assistant", message: { role: "assistant", model } })).join("\n") + "\n");
  return path;
}

describe("resolveEffectiveModel", () => {
  it("reads the runner sidecar model for agy and opencode seats", () => {
    sidecar("agy", "dev-qa@dev-team", { ready: true, updatedAt: "x", model: "gemini-3.8-flash-medium" });
    sidecar("opencode", "orch-lead@dev-team", { ready: true, updatedAt: "x", model: "opencode/glm-5.3-flash-free" });
    expect(resolveEffectiveModel({ runtime: "agy", sessionName: "dev-qa@dev-team", transcriptPath: null }, home)).toBe("gemini-3.8-flash-medium");
    expect(resolveEffectiveModel({ runtime: "opencode", sessionName: "orch-lead@dev-team", transcriptPath: null }, home)).toBe("opencode/glm-5.3-flash-free");
  });

  it("is null when the sidecar is missing, malformed or has no usable model", () => {
    expect(resolveEffectiveModel({ runtime: "agy", sessionName: "none@rig", transcriptPath: null }, home)).toBeNull();
    sidecar("agy", "bad@rig", "{not json");
    sidecar("agy", "nomodel@rig", { ready: true, updatedAt: "x" });
    sidecar("agy", "weird@rig", { ready: true, updatedAt: "x", model: "line\nbreak" });
    sidecar("agy", "huge@rig", { ready: true, updatedAt: "x", model: "m".repeat(500) });
    for (const session of ["bad@rig", "nomodel@rig", "weird@rig", "huge@rig"]) {
      expect(resolveEffectiveModel({ runtime: "agy", sessionName: session, transcriptPath: null }, home)).toBeNull();
    }
  });

  it("refuses session names that could leave the state root", () => {
    sidecar("agy", "ok@rig", { ready: true, updatedAt: "x", model: "gemini-3.8-flash-medium" });
    expect(resolveEffectiveModel({ runtime: "agy", sessionName: "../agy/ok@rig", transcriptPath: null }, home)).toBeNull();
    expect(resolveEffectiveModel({ runtime: "agy", sessionName: "a/b", transcriptPath: null }, home)).toBeNull();
  });

  it("reads the newest model in a Claude transcript and follows it as the file changes", () => {
    const path = claudeTranscript("t1.jsonl", "claude-sonnet-5-5", "claude-opus-5-5");
    expect(resolveEffectiveModel({ runtime: "claude-code", sessionName: "dev-build@rig", transcriptPath: path }, home)).toBe("claude-opus-5-5");
    writeFileSync(path, [
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-haiku-5-5" } }),
    ].join("\n") + "\n");
    expect(resolveEffectiveModel({ runtime: "claude-code", sessionName: "dev-build@rig", transcriptPath: path }, home)).toBe("claude-haiku-5-5");
  });

  it("is null for a missing transcript, no transcript path, or an unsupported runtime", () => {
    expect(resolveEffectiveModel({ runtime: "claude-code", sessionName: "x@rig", transcriptPath: nodePath.join(home, "missing.jsonl") }, home)).toBeNull();
    expect(resolveEffectiveModel({ runtime: "claude-code", sessionName: "x@rig", transcriptPath: null }, home)).toBeNull();
    expect(resolveEffectiveModel({ runtime: "terminal", sessionName: "x@rig", transcriptPath: null }, home)).toBeNull();
    expect(resolveEffectiveModel({ runtime: null, sessionName: null, transcriptPath: null }, home)).toBeNull();
  });
});
