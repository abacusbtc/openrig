// The structural pane classifier reading agy's own console (OPENRIG_AGY_MODE=interactive). The
// frames are real captures from agy 1.4.2, trimmed to the lines that matter.
import { describe, expect, it } from "vitest";
import { classifyPaneActivity } from "../src/domain/session-transport.js";

const RULE = "─".repeat(140);
const frame = (...lines: string[]) => lines.join("\n");

describe("classifyPaneActivity on agy's console", () => {
  it("reads the empty prompt with the shortcuts hint as idle", () => {
    const pane = frame(RULE, ">", RULE, "? for shortcuts                                         Gemini 3.8 Flash · medium");
    expect(classifyPaneActivity(pane).state).toBe("agent_idle");
  });

  it("reads a running turn (spinner row, `esc to cancel` footer) as active", () => {
    const pane = frame(
      "> Count slowly from 1 to 40, one number per line, then say done.",
      "⣽  Generating...", RULE, ">", RULE,
      "esc to cancel                                           Gemini 3.8 Flash · medium",
    );
    expect(classifyPaneActivity(pane).state).toBe("agent_active");
  });

  it("reads a file-access approval as needing input, not as active", () => {
    const pane = frame(
      "Reason: outside workspace", "Allow access to this file?",
      "> 1. Yes, allow access", "  2. Yes, and always allow non-workspace access", "  3. No, deny access",
      "  ↑/↓ Navigate", "esc to cancel                                           Gemini 3.8 Flash · medium",
    );
    expect(classifyPaneActivity(pane).state).toBe("attention");
  });

  it("reads the command approval with the persist option as needing input", () => {
    const pane = frame(
      "Run command: git status", "  1. Yes", "  2. Yes, and always allow for commands that start with 'git'", "  3. No",
      "esc to cancel                                           Gemini 3.8 Flash · medium",
    );
    expect(classifyPaneActivity(pane).state).toBe("attention");
  });
});
