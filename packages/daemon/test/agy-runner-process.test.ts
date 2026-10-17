// End to end: the real runner process driving a fake agy over real pipes.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { agySeatPaths, parseAgyRunnerState, type AgyRunnerState } from "../src/adapters/agy-runner-protocol.js";

const here = nodePath.dirname(fileURLToPath(import.meta.url));
const RUNNER = nodePath.join(here, "../src/adapters/agy-runner.ts");
const FAKE_AGY = nodePath.join(here, "fixtures/fake-agy.mjs");
const CONV = "00000000-0000-4000-8000-00000000abcd";

let dir: string;
let proc: ChildProcessWithoutNullStreams | null;
let output: string;

function startRunner(extra: string[] = [], launchId = "L1") {
  fs.mkdirSync(nodePath.join(dir, "bin"), { recursive: true });
  fs.copyFileSync(FAKE_AGY, nodePath.join(dir, "bin", "agy"));
  fs.chmodSync(nodePath.join(dir, "bin", "agy"), 0o755);
  proc = spawn(process.execPath, ["--import", "tsx", RUNNER,
    "--session-name", "dev-qa@t", "--state-root", nodePath.join(dir, "state"), "--cwd", dir,
    "--launch-id", launchId, "--posture", "floor", ...extra], {
    env: { PATH: `${nodePath.join(dir, "bin")}:${process.env.PATH}`, HOME: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => { output += d.toString(); });
  proc.stderr.on("data", (d) => { output += d.toString(); });
  return proc;
}

const sidecar = (): AgyRunnerState | null => {
  try { return parseAgyRunnerState(fs.readFileSync(agySeatPaths(nodePath.join(dir, "state"), "dev-qa@t").runnerStatePath, "utf8")); } catch { return null; }
};
const spawns = (): string[][] => {
  try { return fs.readFileSync(nodePath.join(dir, "spawns.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)); } catch { return []; }
};

async function until(check: () => boolean, what: string, ms = 15000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}\n--- output ---\n${output}`);
    await new Promise((r) => setTimeout(r, 40));
  }
}

beforeEach(() => { dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "agy-runner-")); output = ""; proc = null; });
afterEach(() => { try { proc?.kill("SIGKILL"); } catch { /* gone */ } fs.rmSync(dir, { recursive: true, force: true }); });

describe("agy-runner process", () => {
  it("comes up ready, runs a turn from pane stdin and records it", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready sidecar");
    expect(sidecar()).toMatchObject({ ready: true, launchId: "L1", conversationId: CONV, busy: false });
    expect(output).toContain(`[agy-runner] READY conversation ${CONV}`);
    p.stdin.write("hello there\n");
    await until(() => output.includes("echo:hello there"), "streamed reply");
    await until(() => sidecar()?.busy === false && !!sidecar()?.lastTurnAt, "turn recorded");
    expect(output).toContain("> hello there");
    expect(spawns()).toHaveLength(1);
    expect(spawns()[0]).toEqual(expect.arrayContaining(["--print=", "--input-format", "stream-json", "--output-format", "stream-json"]));
  });

  it("surfaces denied actions in the pane", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.stdin.write("please deny this\n");
    await until(() => output.includes("denied command: rm -rf /"), "denial notice");
    expect(output).toContain("permissions.allow");
  });

  it("serialises two messages sent back to back", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.stdin.write("one\ntwo\n");
    await until(() => output.includes("echo:one") && output.includes("echo:two"), "both replies");
    expect(output.indexOf("echo:one")).toBeLessThan(output.indexOf("echo:two"));
  });

  it("interrupts a hung turn with SIGINT and resumes the same conversation", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.stdin.write("hang forever\n");
    await until(() => sidecar()?.busy === true, "busy");
    p.stdin.write("/abort\n");
    await until(() => spawns().length === 2, "respawn");
    expect(spawns()[1]).toEqual(expect.arrayContaining(["--conversation", CONV]));
    await until(() => output.includes("agy restarted on conversation"), "restart notice");
    expect(sidecar()).toMatchObject({ ready: true, busy: false, conversationId: CONV });
    // The restarted seat takes the next turn.
    p.stdin.write("still alive\n");
    await until(() => output.includes("echo:still alive"), "turn after interrupt");
    expect(p.exitCode).toBeNull();
  });

  it("unwedges a seat whose agy ignores SIGINT by escalating to SIGTERM", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.stdin.write("stubborn work\n");
    await until(() => sidecar()?.busy === true, "busy");
    p.stdin.write("/abort\n");
    await until(() => output.includes("did not stop on SIGINT; sending SIGTERM"), "escalation notice", 12000);
    await until(() => spawns().length === 2, "respawn after the forced stop", 6000);
    expect(spawns()[1]).toEqual(expect.arrayContaining(["--conversation", CONV]));
    await until(() => sidecar()?.ready === true && sidecar()?.busy === false, "ready again");
    p.stdin.write("back in business\n");
    await until(() => output.includes("echo:back in business"), "turn after forced stop");
  }, 30000);

  it("resumes a requested conversation and passes it to agy", async () => {
    startRunner(["--conversation", CONV]);
    await until(() => sidecar()?.ready === true, "ready");
    expect(spawns()[0]).toEqual(expect.arrayContaining(["--conversation", CONV]));
  });

  it("records an agy crash in the sidecar and exits non-zero", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.stdin.write("die now\n");
    const code = await new Promise<number | null>((resolve) => p.on("close", resolve));
    expect(code).toBe(1);
    expect(sidecar()?.exited).toMatchObject({ code: 3 });
    expect(sidecar()?.ready).toBe(false);
    expect(output).toContain("[agy-runner] EXITED");
  });

  it("exits cleanly and records exit when asked to stop", async () => {
    const p = startRunner();
    await until(() => sidecar()?.ready === true, "ready");
    p.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => p.on("close", resolve));
    expect(code).toBe(0);
    expect(sidecar()?.exited).toBeDefined();
  });

  it("fails fast with exit 127 and a sidecar record when agy is not on PATH", async () => {
    const p = spawn(process.execPath, ["--import", "tsx", RUNNER, "--session-name", "dev-qa@t", "--state-root", nodePath.join(dir, "state"),
      "--cwd", dir, "--launch-id", "L9", "--posture", "floor"], { env: { PATH: "/nonexistent", HOME: dir }, stdio: ["pipe", "pipe", "pipe"] });
    p.stderr.on("data", (d) => { output += d.toString(); });
    const code = await new Promise<number | null>((resolve) => p.on("close", resolve));
    expect(code).toBe(127);
    expect(output).toContain("'agy' was not found on PATH");
    expect(sidecar()).toMatchObject({ ready: false, launchId: "L9", exited: { code: 127 } });
  });

  it("rejects bad arguments with exit 2", async () => {
    const p = spawn(process.execPath, ["--import", "tsx", RUNNER, "--session-name", "x"], { stdio: ["pipe", "pipe", "pipe"] });
    p.stderr.on("data", (d) => { output += d.toString(); });
    const code = await new Promise<number | null>((resolve) => p.on("close", resolve));
    expect(code).toBe(2);
    expect(output).toContain("[agy-runner] ERROR");
  });
});
