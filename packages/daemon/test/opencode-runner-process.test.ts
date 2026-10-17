// End to end: the real runner process driving a fake opencode over real pipes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeSeatPaths, parseOpencodeRunnerState, type OpencodeRunnerState } from "../src/adapters/opencode-runner-protocol.js";

const here = nodePath.dirname(fileURLToPath(import.meta.url));
const RUNNER = nodePath.join(here, "../src/adapters/opencode-runner.ts");
const FAKE_OC = nodePath.join(here, "fixtures/fake-opencode.mjs");
const SID = "ses_fakefakefake0000000000AAAA";

let dir: string;
let proc: ChildProcessWithoutNullStreams | null;
let output: string;

function startRunner(extra: string[] = [], launchId = "L1", posture = "floor") {
  fs.mkdirSync(nodePath.join(dir, "bin"), { recursive: true });
  fs.copyFileSync(FAKE_OC, nodePath.join(dir, "bin", "opencode"));
  fs.chmodSync(nodePath.join(dir, "bin", "opencode"), 0o755);
  proc = spawn(process.execPath, ["--import", "tsx", RUNNER,
    "--session-name", "dev-qa@t", "--state-root", nodePath.join(dir, "state"), "--cwd", dir,
    "--launch-id", launchId, "--posture", posture, ...extra], {
    env: { PATH: `${nodePath.join(dir, "bin")}:${process.env.PATH}`, HOME: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => { output += d.toString(); });
  proc.stderr.on("data", (d) => { output += d.toString(); });
  return proc;
}

const sidecar = (): OpencodeRunnerState | null => {
  try { return parseOpencodeRunnerState(fs.readFileSync(opencodeSeatPaths(nodePath.join(dir, "state"), "dev-qa@t").runnerStatePath, "utf8")); } catch { return null; }
};
const spawns = (): Array<{ argv: string[]; config: string | null }> => {
  try { return fs.readFileSync(nodePath.join(dir, "spawns.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; }
};

async function until(check: () => boolean, what: string, ms = 15000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}\n--- output ---\n${output}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

beforeEach(() => { dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "opencode-runner-")); output = ""; proc = null; });
afterEach(() => { try { proc?.kill("SIGKILL"); } catch { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); });

describe("opencode-runner process", () => {
  it("comes up ready, runs a turn from pane stdin and records it", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready sidecar");
    expect(sidecar()).toMatchObject({ ready: true, launchId: "L1", sessionId: SID, busy: false });
    expect(output).toContain(`[opencode-runner] READY session ${SID}`);
    p.stdin.write("hello there\n");
    await until(() => output.includes("echo:hello there"), "streamed reply");
    await until(() => sidecar()?.busy === false && !!sidecar()?.lastTurnAt, "turn recorded");
    expect(output).toContain("> hello there");
    expect(spawns()).toHaveLength(1);
    expect(spawns()[0]!.argv).toEqual(["acp", "--cwd", dir]);
  });

  it("injects the posture as inline opencode config", async () => {
    startRunner([], "L1", "auto");
    await until(() => sidecar()?.ready === true, "ready");
    expect(JSON.parse(spawns()[0]!.config!)).toEqual({ permission: { edit: "allow", bash: "ask" } });
  });

  it("adds no ask rules for a bypass seat", async () => {
    startRunner([], "L1", "full_bypass");
    await until(() => sidecar()?.ready === true, "ready");
    expect(spawns()[0]!.config).toBeNull();
  });

  it("selects the requested model", async () => {
    startRunner(["--model", "opencode/glm-5.3-flash-free"]);
    await until(() => sidecar()?.ready === true, "ready");
    expect(fs.readFileSync(nodePath.join(dir, "model.log"), "utf8").trim()).toBe("opencode/glm-5.3-flash-free");
  });

  it("fails the launch when the model is refused", async () => {
    const p = startRunner(["--model", "x/nomodel"]);
    const code = await new Promise<number | null>((resolve) => p.on("close", resolve));
    expect(code).toBe(1);
    expect(output).toContain("rejected setModel: unknown model");
    expect(sidecar()).toMatchObject({ ready: false, exited: { } });
  });

  it("serialises two messages sent back to back", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.stdin.write("one\ntwo\n");
    await until(() => output.includes("echo:one") && output.includes("echo:two"), "both replies");
    expect(output.indexOf("echo:one")).toBeLessThan(output.indexOf("echo:two"));
  });

  it("asks the pane for a permission and applies the answer", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.stdin.write("perm please\n");
    await until(() => sidecar()?.awaitingPermission === true, "permission wait");
    expect(output).toContain("PERMISSION execute: rm -rf build");
    p.stdin.write("/deny\n");
    await until(() => output.includes("outcome:selected:reject"), "reject outcome");
    await until(() => sidecar()?.busy === false && !sidecar()?.awaitingPermission, "turn done");
    p.stdin.write("perm again\n");
    await until(() => sidecar()?.awaitingPermission === true, "second wait");
    p.stdin.write("/allow\n");
    await until(() => output.includes("outcome:selected:once"), "allow outcome");
  });

  it("cancels a hung turn gracefully without restarting opencode", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.stdin.write("hang forever\n");
    await until(() => sidecar()?.busy === true, "busy");
    p.stdin.write("/abort\n");
    await until(() => output.includes("turn cancelled"), "cancel notice");
    await until(() => sidecar()?.busy === false, "idle");
    expect(spawns()).toHaveLength(1);
    p.stdin.write("still alive\n");
    await until(() => output.includes("echo:still alive"), "turn after cancel");
    expect(p.exitCode).toBeNull();
  });

  it("force-stops an opencode that ignores cancel and resumes the same session", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.stdin.write("stubborn work\n");
    await until(() => sidecar()?.busy === true, "busy");
    p.stdin.write("/abort\n");
    await until(() => output.includes("sending SIGTERM"), "term notice", 14000);
    await until(() => spawns().length === 2, "respawn after the forced stop", 12000);
    await until(() => sidecar()?.ready === true && sidecar()?.busy === false, "ready again");
    expect(sidecar()?.sessionId).toBe(SID);
    p.stdin.write("back in business\n");
    await until(() => output.includes("echo:back in business"), "turn after forced stop");
  }, 45000);

  it("resumes a requested session through session/resume", async () => {
    startRunner(["--session", "ses_resumeresume0000000000"]);
    await until(() => sidecar()?.ready === true, "ready");
    expect(sidecar()?.sessionId).toBe("ses_resumeresume0000000000");
  });

  it("fails the launch when the session to resume is gone", async () => {
    const p = startRunner(["--session", "ses_gonegonegone0000000000"]);
    const code = await new Promise<number | null>((resolve) => p.on("close", resolve));
    expect(code).toBe(1);
    expect(output).toContain("session not found");
    expect(sidecar()?.ready).toBe(false);
  });

  it("reports a failed prompt and keeps serving", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.stdin.write("fail now\n");
    await until(() => output.includes("turn failed: provider exploded"), "error notice");
    p.stdin.write("next\n");
    await until(() => output.includes("echo:next"), "turn after failure");
  });

  it("records an opencode crash in the sidecar and exits non-zero", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.stdin.write("die now\n");
    const code = await new Promise<number | null>((resolve) => p.on("close", resolve));
    expect(code).toBe(1);
    expect(sidecar()?.exited).toMatchObject({ code: 3 });
    expect(sidecar()?.ready).toBe(false);
    expect(output).toContain("[opencode-runner] EXITED");
  });

  it("exits cleanly and records exit when asked to stop", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => p.on("close", resolve));
    expect(code).toBe(0);
    expect(sidecar()?.exited).toBeDefined();
  });

  it("fails fast with exit 127 and a sidecar record when opencode is not on PATH", async () => {
    const p = spawn(process.execPath, ["--import", "tsx", RUNNER, "--session-name", "dev-qa@t", "--state-root", nodePath.join(dir, "state"),
      "--cwd", dir, "--launch-id", "L9", "--posture", "floor"], { env: { PATH: "/nonexistent", HOME: dir }, stdio: ["pipe", "pipe", "pipe"] });
    p.stderr.on("data", (d) => { output += d.toString(); });
    const code = await new Promise<number | null>((resolve) => p.on("close", resolve));
    expect(code).toBe(127);
    expect(output).toContain("'opencode' was not found on PATH");
    expect(sidecar()).toMatchObject({ ready: false, launchId: "L9", exited: { code: 127 } });
  });

  it("rejects bad arguments with exit 2", async () => {
    const p = spawn(process.execPath, ["--import", "tsx", RUNNER, "--session-name", "x"], { stdio: ["pipe", "pipe", "pipe"] });
    p.stderr.on("data", (d) => { output += d.toString(); });
    const code = await new Promise<number | null>((resolve) => p.on("close", resolve));
    expect(code).toBe(2);
    expect(output).toContain("[opencode-runner] ERROR");
  });
});
