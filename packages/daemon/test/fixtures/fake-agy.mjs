#!/usr/bin/env node
// Fake agy for runner integration tests: speaks the stream-json protocol agy 1.4.0 does.
// Each spawn's argv is appended to spawns.log in its cwd (the runner strips the env, by design). A message containing "stubborn" also ignores SIGINT thereafter. A message containing "hang" never answers
// (so SIGINT can be tested); "deny" ends with a denied_actions result; "die" exits non-zero.
import fs from "node:fs";
import readline from "node:readline";
const argv = process.argv.slice(2);
fs.appendFileSync("spawns.log", JSON.stringify(argv) + "\n");
const ci = argv.indexOf("--conversation");
const conv = ci >= 0 ? argv[ci + 1] : "00000000-0000-4000-8000-00000000abcd";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let step = 0;
let hanging = false;
out({ event: "init", conversation_id: conv, init: { cwd: process.cwd(), tools: ["run_command"], permission_mode: "request-review" } });
process.on("SIGINT", () => {
  out({ event: "result", result: { conversation_id: conv, status: "ERROR", response: "", error: "interrupted", num_turns: 1 } });
  process.exit(1);
});
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  const text = msg.message.content;
  out({ event: "step_update", step_update: { conversation_id: conv, step_index: step++, state: "DONE", step_type: "user_input" } });
  if (text.includes("stubborn")) { process.removeAllListeners("SIGINT"); process.on("SIGINT", () => {}); hanging = true; return; }
  if (text.includes("hang")) { hanging = true; return; }
  if (text.includes("die")) process.exit(3);
  const i = step++;
  out({ event: "step_update", step_update: { conversation_id: conv, step_index: i, state: "ACTIVE", step_type: "agent_response", text_delta: `echo:${text}` } });
  out({ event: "step_update", step_update: { conversation_id: conv, step_index: i, state: "DONE", step_type: "agent_response", text_delta: "\n" } });
  const result = { conversation_id: conv, status: "SUCCESS", response: `echo:${text}\n`, num_turns: 1 };
  if (text.includes("deny")) result.denied_actions = [{ action: "command", display_name: "rm -rf /" }];
  out({ event: "result", result });
});
