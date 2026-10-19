import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { conversationFromLog, findAgyConversation, findAgyLogPath, parseAgyInteractiveState } from "../src/adapters/agy-interactive.js";

const A = "a7afdae8-d3f6-4e61-a648-51f1dcd4b805";
const B = "07234f1c-288c-4324-b504-e403df854e4f";
const store = (log: string) => ({
  dir: "/c",
  list: () => [A, B].map((id) => ({ name: `${id}.db`, createdMs: 2000 })),
  readText: () => log,
});

describe("agy interactive: telling seats apart by their own log", () => {
  it("picks the candidate the log names most often", () => {
    expect(conversationFromLog(`${A} ${A} ${B} other-id`, [A, B])).toBe(A);
  });
  it("gives up on a tie, an unnamed candidate or an empty log", () => {
    expect(conversationFromLog(`${A} ${B}`, [A, B])).toBeNull();
    expect(conversationFromLog("nothing here", [A, B])).toBeNull();
    expect(conversationFromLog("", [A, B])).toBeNull();
  });
  it("resolves two fresh conversations through the log, and stays ambiguous without one", () => {
    const state = { mode: "interactive" as const, launchedAtMs: 1000, logPath: "/l.log" };
    expect(findAgyConversation(state, store(`${B} ${B} ${A}`))).toEqual({ ok: true, conversationId: B });
    expect(findAgyConversation({ ...state, logPath: undefined }, store(`${B}`))).toEqual({ ok: false, reason: "ambiguous" });
    expect(findAgyConversation(state, store(`${A} ${B}`))).toEqual({ ok: false, reason: "ambiguous" });
  });
  it("keeps logPath when parsing the sidecar", () => {
    expect(parseAgyInteractiveState(JSON.stringify({ mode: "interactive", launchedAtMs: 1, logPath: "/l.log" }))?.logPath).toBe("/l.log");
  });
  it("finds the agy process's log under a pane shell", () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "proc-"));
    const proc = (pid: number, comm: string, fd1: string, children: number[]) => {
      const dir = nodePath.join(root, String(pid));
      fs.mkdirSync(nodePath.join(dir, "fd"), { recursive: true });
      fs.mkdirSync(nodePath.join(dir, "task", String(pid)), { recursive: true });
      fs.writeFileSync(nodePath.join(dir, "comm"), `${comm}\n`);
      fs.symlinkSync(fd1, nodePath.join(dir, "fd", "1"));
      fs.writeFileSync(nodePath.join(dir, "task", String(pid), "children"), children.join(" "));
    };
    proc(10, "bash", "/dev/pts/1", [11]);
    proc(11, "agy", "/home/u/.gemini/antigravity-cli/log/cli-1.log", []);
    expect(findAgyLogPath(10, root)).toBe("/home/u/.gemini/antigravity-cli/log/cli-1.log");
    expect(findAgyLogPath(99, root)).toBeNull();
  });
});
