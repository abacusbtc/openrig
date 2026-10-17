#!/usr/bin/env node
// Fake `opencode acp` for runner integration tests: speaks the ACP JSON-RPC subset opencode 1.19.3 does.
// Each spawn's argv and OPENCODE_CONFIG_CONTENT are appended to spawns.log in its cwd. Prompt text drives behaviour:
// "hang" never answers until session/cancel (then stopReason cancelled); "stubborn" ignores cancel and SIGTERM;
// "perm" asks session/request_permission and echoes the outcome; "die" exits 3; "fail" answers a JSON-RPC error.
import fs from "node:fs";
import readline from "node:readline";
const argv = process.argv.slice(2);
fs.appendFileSync("spawns.log", JSON.stringify({ argv, config: process.env.OPENCODE_CONFIG_CONTENT ?? null }) + "\n");
const out = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
const SID = "ses_fakefakefake0000000000AAAA";
let sid = null;
let hungPrompt = null;
let stubborn = false;
let nextAgentId = 100;
const waiting = new Map();
const update = (u) => out({ method: "session/update", params: { sessionId: sid, update: u } });
const finish = (id, stopReason) => out({ id, result: { stopReason } });
const calls = [];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return; }
  switch (m.method) {
    case "initialize":
      out({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: "OpenCode", version: "fake" } } });
      break;
    case "session/new":
      sid = SID;
      out({ id: m.id, result: { sessionId: sid } });
      break;
    case "session/resume":
      sid = m.params.sessionId;
      if (sid.includes("gone")) { out({ id: m.id, error: { code: -32002, message: "session not found" } }); break; }
      out({ id: m.id, result: {} });
      break;
    case "session/set_config_option":
      calls.push(m.params.value);
      if (String(m.params.value).includes("nomodel")) out({ id: m.id, error: { code: -32602, message: "unknown model" } });
      else out({ id: m.id, result: { configOptions: [] } });
      fs.appendFileSync("model.log", `${m.params.value}\n`);
      break;
    case "session/cancel":
      if (hungPrompt !== null && !stubborn) { finish(hungPrompt, "cancelled"); hungPrompt = null; }
      break;
    case "session/prompt": {
      const text = m.params.prompt[0].text;
      if (text.includes("stubborn")) { process.on("SIGTERM", () => {}); stubborn = true; hungPrompt = m.id; break; }
      if (text.includes("hang")) { hungPrompt = m.id; break; }
      if (text.includes("die")) process.exit(3);
      if (text.includes("fail")) { out({ id: m.id, error: { code: -32000, message: "provider exploded" } }); break; }
      if (text.includes("perm")) {
        const rid = nextAgentId++;
        update({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", kind: "execute", status: "pending" });
        update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress", kind: "execute", title: "rm -rf build" });
        waiting.set(rid, (res) => {
          const o = res.outcome;
          update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `outcome:${o.outcome}:${o.optionId ?? ""}\n` } });
          update({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: o.optionId === "reject" || o.outcome === "cancelled" ? "failed" : "completed", kind: "execute" });
          finish(m.id, "end_turn");
        });
        out({ id: rid, method: "session/request_permission", params: { sessionId: sid, toolCall: { toolCallId: "t1", title: "rm -rf build", kind: "execute", status: "pending" },
          options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "always", kind: "allow_always", name: "Always allow" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] } });
        break;
      }
      update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo:${text}` } });
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "\n" } });
      finish(m.id, "end_turn");
      break;
    }
    default:
      if (m.id !== undefined) out({ id: m.id, error: { code: -32601, message: "no" } });
  }
});
