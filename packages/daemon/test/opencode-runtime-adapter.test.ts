// Hermetic tests for the opencode runtime adapter and resume adapter. No live opencode: launch/resume
// command construction, launch-scoped sidecar readiness, token capture, posture, projection
// and startup delivery are all fake-backed. The live leg is the dev-team seat test.

import { describe, it, expect, vi } from "vitest";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import { OpencodeRuntimeAdapter, opencodeModel, resolveOpencodePosture, type OpencodeAdapterFsOps } from "../src/adapters/opencode-runtime-adapter.js";
import { OpencodeResumeAdapter } from "../src/adapters/opencode-resume.js";
import { opencodeSeatPaths } from "../src/adapters/opencode-runner-protocol.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";

const STATE_ROOT = "/openrig-home/state/opencode";
const RUNNER = "/daemon-dist/adapters/opencode-runner.js";
const SESSION = "dev-qa@dev-team";
const CONV = "ses_eb49b1749ffeC6daza8UI6Qof5";
const OTHER = "ses_zzzzzzzzzzzzzzzzzzzzzzzzzz";
const SIDECAR = opencodeSeatPaths(STATE_ROOT, SESSION).runnerStatePath;

function mockTmux(o: Partial<Record<"sendText" | "sendShellCommand" | "sendKeys" | "capturePaneContent" | "hasSession" | "getPaneCommand", unknown>> = {}) {
  return {
    sendText: o.sendText ?? vi.fn(async () => ({ ok: true as const })),
    sendShellCommand: o.sendShellCommand ?? vi.fn(async () => ({ ok: true as const })),
    sendKeys: o.sendKeys ?? vi.fn(async () => ({ ok: true as const })),
    capturePaneContent: o.capturePaneContent ?? vi.fn(async () => ""),
    hasSession: o.hasSession ?? vi.fn(async () => true),
    getPaneCommand: o.getPaneCommand ?? vi.fn(async () => "node"),
  } as unknown as TmuxAdapter & {
    sendText: ReturnType<typeof vi.fn>; sendShellCommand: ReturnType<typeof vi.fn>; sendKeys: ReturnType<typeof vi.fn>;
  };
}

function memFs(files: Record<string, string> = {}): OpencodeAdapterFsOps & { files: Record<string, string>; dirs: Set<string>; modes: Record<string, number> } {
  const dirs = new Set<string>();
  const modes: Record<string, number> = {};
  return {
    files, dirs, modes,
    readFile: (p) => { if (!(p in files)) throw new Error(`ENOENT: ${p}`); return files[p]!; },
    writeFile: (p, c) => { files[p] = c; },
    exists: (p) => p in files || dirs.has(p),
    mkdirp: (p) => { dirs.add(p); },
    listFiles: (dir) => Object.keys(files).filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
    statMode: () => 0o755,
    chmod: (p, m) => { modes[p] = m; },
  };
}

const launchIdFrom = (cmd: string): string => {
  const m = /--launch-id '([^']+)'/.exec(cmd);
  if (!m) throw new Error("typed command carries no --launch-id");
  return m[1]!;
};
const state = (extra: Record<string, unknown>) => JSON.stringify({ updatedAt: "2026-10-17T00:00:00Z", ...extra });
const binding = (o: Partial<NodeBinding> = {}): NodeBinding => ({ cwd: "/work", tmuxSession: SESSION, nodeId: "n1", ...o } as NodeBinding);

function adapterWith(fs: OpencodeAdapterFsOps, tmux: TmuxAdapter, newLaunchId = () => "L1") {
  return new OpencodeRuntimeAdapter({ tmux, fsOps: fs, stateRoot: STATE_ROOT, runnerEntryPath: RUNNER, sleep: async () => {}, newLaunchId });
}

/** A tmux whose typed launch command makes a fake runner write the given sidecar for that attempt. */
function runnerThatWrites(fs: ReturnType<typeof memFs>, write: (launchId: string) => string | null) {
  return mockTmux({
    sendShellCommand: vi.fn(async (_t: string, cmd: string) => {
      const out = write(launchIdFrom(cmd));
      if (out !== null) fs.files[SIDECAR] = out;
      return { ok: true as const } as TmuxResult;
    }),
  });
}

describe("resolveOpencodePosture / opencodeModel", () => {
  it("an explicit resolved posture wins in both directions", () => {
    expect(resolveOpencodePosture({ OPENRIG_YOLO: "1" }, "floor")).toBe("floor");
    expect(resolveOpencodePosture({}, "full_bypass")).toBe("full_bypass");
    expect(resolveOpencodePosture({}, "auto")).toBe("auto");
  });
  it("falls back to the YOLO environment switch", () => {
    expect(resolveOpencodePosture({ OPENRIG_YOLO: "1" })).toBe("full_bypass");
    expect(resolveOpencodePosture({ OPENRIG_YOLO: "true" })).toBe("full_bypass");
    expect(resolveOpencodePosture({})).toBe("floor");
  });
  it("trims the model and drops a blank one", () => {
    expect(opencodeModel(" opencode/glm-5.3-flash-free ")).toBe("opencode/glm-5.3-flash-free");
    expect(opencodeModel("  ")).toBeUndefined();
    expect(opencodeModel(undefined)).toBeUndefined();
  });
});

describe("OpencodeRuntimeAdapter.launchHarness", () => {
  it("types the runner command, proves readiness from THIS attempt's sidecar, and returns the session token", async () => {
    const fs = memFs();
    const tmux = runnerThatWrites(fs, (id) => state({ ready: true, launchId: id, sessionId: CONV }));
    const result = await adapterWith(fs, tmux).launchHarness(binding({ model: "opencode/glm-5.3-flash-free" }), { name: "x" });
    expect(result).toMatchObject({ ok: true, resumeToken: CONV, resumeType: "opencode_session_id" });
    const cmd = tmux.sendShellCommand.mock.calls[0]![1] as string;
    expect(cmd).toContain(`node '${RUNNER}'`);
    expect(cmd).toContain("--posture floor");
    expect(cmd).toContain("--model 'opencode/glm-5.3-flash-free'");
    expect(cmd).not.toContain("--session ");
    expect((result as { appliedLaunch?: unknown }).appliedLaunch).toMatchObject({ runtime: "opencode", axis: "permission", value: "request-review" });
  });

  it("writes a pending sidecar BEFORE typing the command, keeping the launch id", async () => {
    const fs = memFs({ [SIDECAR]: state({ ready: true, launchId: "OLD", sessionId: OTHER }) });
    let seenAtType: string | undefined;
    const tmux = mockTmux({
      sendShellCommand: vi.fn(async (_t: string, cmd: string) => {
        seenAtType = fs.files[SIDECAR];
        fs.files[SIDECAR] = state({ ready: true, launchId: launchIdFrom(cmd), sessionId: CONV });
        return { ok: true as const };
      }),
    });
    await adapterWith(fs, tmux).launchHarness(binding(), { name: "x" });
    expect(JSON.parse(seenAtType!)).toMatchObject({ ready: false, launchId: "L1" });
  });

  it("ignores a stale ready sidecar from a previous runner instance", async () => {
    const fs = memFs();
    const tmux = runnerThatWrites(fs, () => state({ ready: true, launchId: "STALE", sessionId: CONV }));
    const result = await adapterWith(fs, tmux).launchHarness(binding(), { name: "x" });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    expect((result as { error: string }).error).toContain("timed out");
  });

  it("reports a runner that exited, with pane evidence", async () => {
    const fs = memFs();
    const tmux = mockTmux({
      sendShellCommand: vi.fn(async (_t: string, cmd: string) => {
        fs.files[SIDECAR] = state({ ready: false, launchId: launchIdFrom(cmd), exited: { code: 127, at: "t" } });
        return { ok: true as const };
      }),
      capturePaneContent: vi.fn(async () => "line1\n[opencode-runner] ERROR 'opencode' was not found on PATH\n"),
    });
    const result = await adapterWith(fs, tmux).launchHarness(binding(), { name: "x" });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    expect((result as { error: string }).error).toContain("code 127");
    expect((result as { evidence?: string }).evidence).toContain("not found on PATH");
  });

  it("fails fast, with pane evidence, when the pane returns to a shell before the runner ever reports", async () => {
    const fs = memFs();
    let polls = 0;
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => (++polls > 0 ? "zsh" : "node")),
      capturePaneContent: vi.fn(async () => "bash: node: command not found"),
    });
    const result = await adapterWith(fs, tmux).launchHarness(binding(), { name: "x" });
    expect(result).toMatchObject({ ok: false, recovery: "attention_required" });
    expect((result as { error: string }).error).toContain("returned to a shell");
    expect((result as { evidence?: string }).evidence).toContain("command not found");
    // 12 grace attempts + 2 observations, well short of the 120-attempt timeout.
    expect(polls).toBeLessThan(20);
  });

  it("does not fail fast while the pane is running the runner", async () => {
    const fs = memFs();
    let n = 0;
    const tmux = mockTmux({
      sendShellCommand: vi.fn(async (_t: string, cmd: string) => {
        const id = launchIdFrom(cmd);
        // The runner reports ready only after many polls; the pane is a node process throughout.
        setTimeout(() => {}, 0);
        fs.files[SIDECAR] = state({ ready: false, launchId: id });
        return { ok: true as const };
      }),
      getPaneCommand: vi.fn(async () => { if (++n === 30) fs.files[SIDECAR] = state({ ready: true, launchId: "L1", sessionId: CONV }); return "node"; }),
    });
    expect(await adapterWith(fs, tmux).launchHarness(binding(), { name: "x" })).toMatchObject({ ok: true, resumeToken: CONV });
  });

  it("passes the posture and a validated resume session to the runner", async () => {
    const fs = memFs();
    const tmux = runnerThatWrites(fs, (id) => state({ ready: true, launchId: id, sessionId: CONV }));
    const result = await adapterWith(fs, tmux).launchHarness(binding({ launchPosture: "full_bypass" }), { name: "x", resumeToken: CONV });
    const cmd = tmux.sendShellCommand.mock.calls[0]![1] as string;
    expect(cmd).toContain("--posture full_bypass");
    expect(cmd).toContain(`--session '${CONV}'`);
    expect(result).toMatchObject({ ok: true, appliedLaunch: { value: "bypass" } });
  });

  it("rejects a malformed resume token before typing anything", async () => {
    const tmux = mockTmux();
    const result = await adapterWith(memFs(), tmux).launchHarness(binding(), { name: "x", resumeToken: "--dangerously-skip-permissions" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("opencode resume");
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });

  it("fails when a resume came up on a different session", async () => {
    const fs = memFs();
    const tmux = runnerThatWrites(fs, (id) => state({ ready: true, launchId: id, sessionId: OTHER }));
    const result = await adapterWith(fs, tmux).launchHarness(binding(), { name: "x", resumeToken: CONV });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("does not report the requested session");
  });

  it("refuses a model that is not <provider>/<model> before typing anything", async () => {
    const tmux = mockTmux();
    const result = await adapterWith(memFs(), tmux).launchHarness(binding({ model: "Gemini 3.8 Flash (Medium)" }), { name: "x" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("<provider>/<model>");
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });

  it("refuses to fork until the runner drives session/fork", async () => {
    const tmux = mockTmux();
    const result = await adapterWith(memFs(), tmux).launchHarness(binding(), { name: "x", forkSource: { kind: "native_id", value: CONV } });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("fork is not supported");
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });

  it("fails without a tmux session, and when the command cannot be typed", async () => {
    expect(await adapterWith(memFs(), mockTmux()).launchHarness(binding({ tmuxSession: undefined as unknown as string }), { name: "x" }))
      .toMatchObject({ ok: false });
    const tmux = mockTmux({ sendShellCommand: vi.fn(async () => ({ ok: false as const, code: "x", message: "no pane" })) });
    const result = await adapterWith(memFs(), tmux).launchHarness(binding(), { name: "x" });
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toContain("no pane");
  });

  it("a ready runner that reports no session id is a failure", async () => {
    const fs = memFs();
    const tmux = runnerThatWrites(fs, (id) => state({ ready: true, launchId: id }));
    expect(await adapterWith(fs, tmux).launchHarness(binding(), { name: "x" })).toMatchObject({ ok: false });
  });
});

describe("OpencodeRuntimeAdapter.checkReady", () => {
  const ready = (extra: Record<string, unknown> = {}) => state({ ready: true, launchId: "L", sessionId: CONV, ...extra });
  it("ready: sidecar ready and the pane is not at a shell", async () => {
    expect(await adapterWith(memFs({ [SIDECAR]: ready() }), mockTmux()).checkReady(binding())).toEqual({ ready: true });
  });
  it("not ready when the sidecar says ready but the pane is back at a shell", async () => {
    const r = await adapterWith(memFs({ [SIDECAR]: ready() }), mockTmux({ getPaneCommand: vi.fn(async () => "zsh") })).checkReady(binding());
    expect(r).toMatchObject({ ready: false, code: "runner_exited" });
  });
  it("not ready once the runner recorded an exit", async () => {
    const r = await adapterWith(memFs({ [SIDECAR]: ready({ exited: { code: 1, at: "t" } }) }), mockTmux()).checkReady(binding());
    expect(r).toMatchObject({ ready: false, code: "runner_exited" });
  });
  it("falls back to the runner's pane markers when there is no sidecar", async () => {
    const pane = (text: string) => mockTmux({ capturePaneContent: vi.fn(async () => text) });
    expect(await adapterWith(memFs(), pane("[opencode-runner] READY session x")).checkReady(binding())).toEqual({ ready: true });
    expect(await adapterWith(memFs(), pane("[opencode-runner] ERROR boom")).checkReady(binding())).toMatchObject({ code: "runner_error" });
    expect(await adapterWith(memFs(), pane("[opencode-runner] EXITED")).checkReady(binding())).toMatchObject({ code: "runner_exited" });
    expect(await adapterWith(memFs(), pane("")).checkReady(binding())).toMatchObject({ code: "awaiting_runtime" });
  });
  it("a stale READY marker at a shell is not ready", async () => {
    const tmux = mockTmux({ capturePaneContent: vi.fn(async () => "[opencode-runner] READY x"), getPaneCommand: vi.fn(async () => "bash") });
    expect(await adapterWith(memFs(), tmux).checkReady(binding())).toMatchObject({ ready: false, code: "runner_exited" });
  });
  it("treats a login shell's dashed name (-bash) as a shell", async () => {
    const tmux = mockTmux({ getPaneCommand: vi.fn(async () => "-bash") });
    expect(await adapterWith(memFs({ [SIDECAR]: ready() }), tmux).checkReady(binding())).toMatchObject({ ready: false, code: "runner_exited" });
    const stale = mockTmux({ capturePaneContent: vi.fn(async () => "[opencode-runner] READY x"), getPaneCommand: vi.fn(async () => "-zsh") });
    expect(await adapterWith(memFs(), stale).checkReady(binding())).toMatchObject({ ready: false, code: "runner_exited" });
  });
  it("not ready without a tmux session or a live session", async () => {
    expect(await adapterWith(memFs(), mockTmux()).checkReady(binding({ tmuxSession: undefined as unknown as string }))).toMatchObject({ ready: false });
    expect(await adapterWith(memFs(), mockTmux({ hasSession: vi.fn(async () => false) })).checkReady(binding())).toMatchObject({ ready: false });
  });
});

describe("OpencodeRuntimeAdapter.readSessionFile (resume token capture)", () => {
  it("exposes the session id from the sidecar", () => {
    const a = adapterWith(memFs({ [SIDECAR]: state({ ready: true, sessionId: CONV }) }), mockTmux());
    expect(a.readSessionFile(SESSION)).toEqual({ ok: true, sessionFile: CONV });
  });
  it("distinguishes missing, unparseable and id-less sidecars", () => {
    expect(adapterWith(memFs(), mockTmux()).readSessionFile(SESSION)).toEqual({ ok: false, reason: "missing_sidecar" });
    expect(adapterWith(memFs({ [SIDECAR]: "{nope" }), mockTmux()).readSessionFile(SESSION)).toEqual({ ok: false, reason: "parse_error" });
    expect(adapterWith(memFs({ [SIDECAR]: state({ ready: false }) }), mockTmux()).readSessionFile(SESSION)).toEqual({ ok: false, reason: "missing_sidecar" });
  });
});

describe("OpencodeRuntimeAdapter.project", () => {
  const entry = (o: Partial<ProjectionEntry>): ProjectionEntry => ({
    category: "skill", effectiveId: "tdd", sourceSpec: "s", sourcePath: "p", resourcePath: "r",
    absolutePath: "/src/tdd", classification: "safe_projection", ...o,
  } as ProjectionEntry);
  const plan = (entries: ProjectionEntry[]): ProjectionPlan => ({ runtime: "opencode", cwd: "/work", entries, startup: {} as ProjectionPlan["startup"], conflicts: [], noOps: [], diagnostics: [] });

  it("copies a directory skill, with helpers and file modes, into <cwd>/.agents/skills/<id>", async () => {
    const fs = memFs({ "/src/tdd/SKILL.md": "# tdd", "/src/tdd/helpers/run.sh": "#!/bin/sh" });
    const result = await adapterWith(fs, mockTmux()).project(plan([entry({})]), binding());
    expect(result.projected).toEqual(["tdd"]);
    expect(fs.files["/work/.agents/skills/tdd/SKILL.md"]).toBe("# tdd");
    expect(fs.files["/work/.agents/skills/tdd/helpers/run.sh"]).toBe("#!/bin/sh");
    expect(fs.modes["/work/.agents/skills/tdd/helpers/run.sh"]).toBe(0o755);
  });
  it("copies a file-shaped skill", async () => {
    const fs = memFs({ "/src/one.md": "# one" });
    const result = await adapterWith(fs, mockTmux()).project(plan([entry({ effectiveId: "one", absolutePath: "/src/one.md" })]), binding());
    expect(result.projected).toEqual(["one"]);
    expect(fs.files["/work/.agents/skills/one/one.md"]).toBe("# one");
  });
  it("skips an unchanged file skill but re-copies an unchanged directory skill", async () => {
    const fs = memFs({ "/src/tdd/SKILL.md": "# tdd", "/src/f.md": "f" });
    const result = await adapterWith(fs, mockTmux()).project(plan([
      entry({ classification: "no_op" }),
      entry({ effectiveId: "f", absolutePath: "/src/f.md", classification: "no_op" }),
    ]), binding());
    expect(result.projected).toEqual(["tdd"]);
    expect(result.skipped).toEqual(["f"]);
  });
  it("merges managed guidance into AGENTS.md but never the per-seat rig-role block", async () => {
    const fs = memFs({ "/src/g.md": "be nice", "/src/role.md": "role" });
    const a = adapterWith(fs, mockTmux());
    const result = await a.project(plan([
      entry({ category: "guidance", effectiveId: "team-rules", absolutePath: "/src/g.md", mergeStrategy: "managed_block" }),
      entry({ category: "guidance", effectiveId: "rig-role", absolutePath: "/src/role.md", mergeStrategy: "managed_block" }),
    ]), binding());
    expect(result.projected).toEqual(["team-rules"]);
    expect(result.skipped).toEqual(["rig-role"]);
    expect(fs.files["/work/AGENTS.md"]).toContain("be nice");
    expect(fs.files["/work/AGENTS.md"]).not.toContain("role");
  });
  it("honestly skips resources opencode has no target for, and reports per-entry failures", async () => {
    const fs = memFs();
    const result = await adapterWith(fs, mockTmux()).project(plan([
      entry({ category: "plugin", effectiveId: "pl", absolutePath: "/src/pl" }),
      entry({ category: "guidance", effectiveId: "broken", absolutePath: "/missing.md", mergeStrategy: "managed_block" }),
    ]), binding());
    expect(result.skipped).toEqual(["pl"]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]!.effectiveId).toBe("broken");
  });
  it("lists installed skills from the workspace", async () => {
    const fs = memFs({ "/work/.agents/skills/a/SKILL.md": "a" });
    fs.dirs.add("/work/.agents/skills");
    const listed = await adapterWith(fs, mockTmux()).listInstalled(binding());
    expect(listed).toEqual([{ effectiveId: "a/SKILL.md", category: "skill", installedPath: "/work/.agents/skills/a/SKILL.md" }]);
  });
});

describe("OpencodeRuntimeAdapter.deliverStartup", () => {
  const file = (o: Partial<ResolvedStartupFile>): ResolvedStartupFile => ({
    path: "guidance/role.md", absolutePath: "/src/role.md", ownerRoot: "/src", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"], ...o,
  } as ResolvedStartupFile);

  it("types send_text content into the pane and submits it (the runner turns it into the first turn)", async () => {
    const tmux = mockTmux();
    const result = await adapterWith(memFs({ "/src/role.md": "You are QA." }), tmux).deliverStartup([file({})], binding());
    expect(result.delivered).toBe(1);
    expect(tmux.sendText).toHaveBeenCalledWith(SESSION, "You are QA.");
    expect(tmux.sendKeys).toHaveBeenCalledWith(SESSION, ["Enter"]);
  });
  it("merges guidance into AGENTS.md and installs skills into the workspace", async () => {
    const fs = memFs({ "/src/g.md": "rules", "/src/sk/SKILL.md": "# sk" });
    const result = await adapterWith(fs, mockTmux()).deliverStartup([
      file({ path: "team.md", absolutePath: "/src/g.md", deliveryHint: "guidance_merge" }),
      file({ path: "SKILL.md", absolutePath: "/src/sk/SKILL.md", deliveryHint: "skill_install" }),
    ], binding());
    expect(result.delivered).toBe(2);
    expect(fs.files["/work/AGENTS.md"]).toContain("rules");
    expect(fs.files["/work/.agents/skills/sk/SKILL.md"]).toBe("# sk");
  });
  it("counts a required failure but swallows an optional one", async () => {
    const tmux = mockTmux({ sendText: vi.fn(async () => ({ ok: false as const, code: "x", message: "pane gone" })) });
    const a = adapterWith(memFs({ "/src/role.md": "r" }), tmux);
    expect((await a.deliverStartup([file({})], binding())).failed).toEqual([{ path: "guidance/role.md", error: "pane gone" }]);
    expect((await a.deliverStartup([file({ required: false })], binding())).failed).toEqual([]);
  });
});

describe("OpencodeResumeAdapter", () => {
  function resumeWith(fs: ReturnType<typeof memFs>, tmux: TmuxAdapter, maxWaitMs = 1000) {
    return new OpencodeResumeAdapter(tmux, fs, { stateRoot: STATE_ROOT, runnerEntryPath: RUNNER }, { pollMs: 1, maxWaitMs, sleep: async () => {}, newLaunchId: () => "R1" });
  }

  it("only resumes opencode session tokens", () => {
    const a = resumeWith(memFs(), mockTmux());
    expect(a.canResume("opencode_session_id", CONV)).toBe(true);
    expect(a.canResume("opencode_session_id", null)).toBe(false);
    expect(a.canResume("pi_session_file", "/x.jsonl")).toBe(false);
    expect(a.canResume("codex_id", CONV)).toBe(false);
  });

  it("relaunches the runner on the persisted session and proves it from the launch-scoped sidecar", async () => {
    const fs = memFs({ [SIDECAR]: state({ ready: true, launchId: "OLD", sessionId: OTHER }) });
    const tmux = runnerThatWrites(fs, (id) => state({ ready: true, launchId: id, sessionId: CONV }));
    const result = await resumeWith(fs, tmux).resume(SESSION, "opencode_session_id", CONV, "/work", "opencode/glm-5.3-flash-free", "auto");
    expect(result).toMatchObject({ ok: true, appliedLaunch: { runtime: "opencode", value: "auto" } });
    const cmd = tmux.sendShellCommand.mock.calls[0]![1] as string;
    expect(cmd).toContain(`--session '${CONV}'`);
    expect(cmd).toContain("--posture auto");
    expect(cmd).toContain("--model 'opencode/glm-5.3-flash-free'");
    expect(cmd).toContain("--launch-id 'R1'");
  });

  it("refuses a malformed model on resume before typing anything", async () => {
    const tmux = mockTmux();
    const result = await resumeWith(memFs(), tmux).resume(SESSION, "opencode_session_id", CONV, "/work", "--evil", "floor");
    expect(result).toMatchObject({ ok: false, code: "resume_failed" });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });

  it("fails when the runner comes up on a different session", async () => {
    const fs = memFs();
    const tmux = runnerThatWrites(fs, (id) => state({ ready: true, launchId: id, sessionId: OTHER }));
    const result = await resumeWith(fs, tmux).resume(SESSION, "opencode_session_id", CONV, "/work");
    expect(result).toMatchObject({ ok: false, code: "resume_failed" });
    expect((result as { message: string }).message).toContain("does not report the requested session");
  });

  it("fails with pane evidence when the runner exits", async () => {
    const fs = memFs();
    const tmux = mockTmux({
      sendShellCommand: vi.fn(async (_t: string, cmd: string) => {
        fs.files[SIDECAR] = state({ ready: false, launchId: launchIdFrom(cmd), exited: { code: 1, at: "t" } });
        return { ok: true as const };
      }),
      capturePaneContent: vi.fn(async () => "[opencode-runner] ERROR resumed session X but Y was requested"),
    });
    const result = await resumeWith(fs, tmux).resume(SESSION, "opencode_session_id", CONV, "/work");
    expect(result).toMatchObject({ ok: false, code: "resume_failed" });
    expect((result as { evidence?: string }).evidence).toContain("was requested");
  });

  it("ignores a stale sidecar and times out when this attempt never reports", async () => {
    const fs = memFs();
    const tmux = runnerThatWrites(fs, () => state({ ready: true, launchId: "STALE", sessionId: CONV }));
    const result = await resumeWith(fs, tmux, 5).resume(SESSION, "opencode_session_id", CONV, "/work");
    expect(result).toMatchObject({ ok: false, code: "resume_failed" });
    expect((result as { message: string }).message).toContain("timed out");
  });

  it("fails fast when the pane returns to a shell before the resumed runner reports", async () => {
    const tmux = mockTmux({ getPaneCommand: vi.fn(async () => "-bash"), capturePaneContent: vi.fn(async () => "Error: Cannot find module") });
    const result = await resumeWith(memFs(), tmux, 10_000).resume(SESSION, "opencode_session_id", CONV, "/work");
    expect(result).toMatchObject({ ok: false, code: "resume_failed" });
    expect((result as { message: string }).message).toContain("returned to a shell");
    expect((result as { evidence?: string }).evidence).toContain("Cannot find module");
  });

  it("refuses a missing or malformed token and a command that cannot be typed", async () => {
    const tmux = mockTmux();
    const a = resumeWith(memFs(), tmux);
    expect(await a.resume(SESSION, "opencode_session_id", null, "/work")).toMatchObject({ ok: false, code: "no_resume" });
    expect(await a.resume(SESSION, "opencode_session_id", "not-a-uuid", "/work")).toMatchObject({ ok: false, code: "resume_failed" });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
    const failing = mockTmux({ sendShellCommand: vi.fn(async () => ({ ok: false as const, code: "x", message: "no pane" })) });
    expect(await resumeWith(memFs(), failing).resume(SESSION, "opencode_session_id", CONV, "/work")).toMatchObject({ ok: false, message: "no pane" });
  });
});

