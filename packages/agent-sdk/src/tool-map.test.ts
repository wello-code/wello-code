import { describe, expect, it } from "vitest";
import { classifyTool, classifyToolFailure, summarizeTool, toToolIntent } from "./tool-map";

describe("tool-map", () => {
  it("classifies tools into capability + risk", () => {
    expect(classifyTool("Read")).toEqual({ capability: "read", risk: "low" });
    expect(classifyTool("Write")).toEqual({ capability: "write", risk: "medium" });
    expect(classifyTool("Bash")).toEqual({ capability: "command", risk: "high" });
    expect(classifyTool("WebFetch")).toEqual({ capability: "network", risk: "medium" });
    expect(classifyTool("Task")).toEqual({ capability: "command", risk: "low" });
    expect(classifyTool("mcp__srv__tool")).toEqual({ capability: "network", risk: "medium" });
  });

  it("labels a subagent Task with its description or type", () => {
    expect(summarizeTool("Task", { description: "Design audit" })).toBe("Subagent · Design audit");
    expect(summarizeTool("Task", { subagent_type: "reviewer" })).toBe("Subagent · reviewer");
    expect(summarizeTool("Task", {})).toBe("Subagent · task");
  });


  it("classifies the Workflow orchestration tool as a low-risk command", () => {
    expect(classifyTool("Workflow")).toEqual({ capability: "command", risk: "low" });
  });

  it("labels a Workflow with its name from input, script meta, or script path", () => {
    expect(summarizeTool("Workflow", { name: "review-changes" })).toBe("Workflow · review-changes");
    expect(
      summarizeTool("Workflow", {
        script: "export const meta = {\n  name: 'double-ping',\n  description: 'x',\n}\nphase('P')",
      }),
    ).toBe("Workflow · double-ping");
    expect(
      summarizeTool("Workflow", { scriptPath: "C:\\sess\\workflows\\scripts\\audit-wf_1.js" }),
    ).toBe("Workflow · audit-wf_1");
    expect(summarizeTool("Workflow", {})).toBe("Workflow · сценарий");
  });

  it("maps tools to schema-valid structured intents", () => {
    expect(toToolIntent("Read", { file_path: "a.ts" }, "/w")).toEqual({
      kind: "read_file",
      paths: ["a.ts"],
    });
    expect(toToolIntent("Bash", { command: "ls -a" }, "/w")).toEqual({
      kind: "run_command",
      argv: ["ls -a"],
      cwd: "/w",
    });
    expect(toToolIntent("Grep", { pattern: "foo" }, "/w")).toEqual({
      kind: "search",
      query: "foo",
      rootId: "/w",
    });
  });
});

describe("classifyToolFailure", () => {
  it("marks self-recoverable engine errors as recovered", () => {
    for (const msg of [
      "File has not been read yet. Read it first before writing to it.",
      "String to replace not found in file.",
      "Found 3 matches of the string to replace, but expected 1",
      "File has been modified since read, either by the user or by a linter.",
      "No changes to make: old_string and new_string are exactly the same.",
    ]) {
      expect(classifyToolFailure(msg)).toBe("recovered");
    }
  });

  it("keeps genuine failures as failed", () => {
    expect(classifyToolFailure("Command failed with exit code 1: npm test")).toBe("failed");
    expect(classifyToolFailure("Permission denied")).toBe("failed");
    expect(classifyToolFailure("")).toBe("failed");
  });
});
