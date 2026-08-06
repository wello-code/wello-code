import { describe, expect, it } from "vitest";
import { classifyTool, classifyToolFailure, editPreview, summarizeTool, toToolIntent } from "./tool-map";

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

  it("plan approval is its OWN capability — no command grant may cover it", () => {
    // Probed live: the engine consults the permission callback for ExitPlanMode.
    // Classified as «command» it inherited broad command grants and plan mode
    // ended silently — the model went on editing files under a «План» selector.
    expect(classifyTool("ExitPlanMode")).toEqual({ capability: "plan", risk: "medium" });
    expect(summarizeTool("ExitPlanMode", {})).toBe("Запрос на выполнение плана");
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

describe("editPreview (the before/after excerpt on write cards)", () => {
  it("renders an Edit as removed and added lines", () => {
    const p = editPreview("Edit", { old_string: "color=red", new_string: "color=blue" });
    expect(p).toBe("- color=red\n+ color=blue");
  });

  it("trims long sides and counts what was cut", () => {
    const many = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    const p = editPreview("Edit", { old_string: many, new_string: "one" })!;
    expect(p).toContain("- line 0");
    expect(p).toContain("… ещё 23 строк");
    expect(p).toContain("+ one");
    // Never grows unbounded: the card must not bury its own buttons.
    expect(p.split("\n").length).toBeLessThanOrEqual(16);
  });

  it("Write shows the new content as additions", () => {
    const p = editPreview("Write", { content: "a\nb" });
    expect(p).toBe("+ a\n+ b");
  });

  it("MultiEdit shows the first edit and counts the rest", () => {
    const p = editPreview("MultiEdit", {
      edits: [
        { old_string: "x", new_string: "y" },
        { old_string: "i", new_string: "j" },
      ],
    });
    expect(p).toBe("- x\n+ y\n… и ещё 1 правок");
  });

  it("returns undefined when there is nothing meaningful to show", () => {
    expect(editPreview("Edit", {})).toBeUndefined();
    expect(editPreview("Write", {})).toBeUndefined();
    expect(editPreview("MultiEdit", { edits: [] })).toBeUndefined();
    expect(editPreview("Bash", { command: "ls" })).toBeUndefined();
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
