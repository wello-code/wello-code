import { describe, expect, it } from "vitest";
import { parseAgentEvent } from "@wello-code/contracts";
import {
  contextTokensFromUsage,
  engineModelId,
  githubSystemAppend,
  normalizeDirPrefix,
  pathInsideRoots,
  resolveEffort,
  taskIdFromCreateResult,
  todosFromToolInput,
  workflowProgressAgents,
} from "./session";

describe("githubSystemAppend (the anti-'gh auth login' steering)", () => {
  it("connected + bridged: git is authenticated, publish via github_create_repo", () => {
    const s = githubSystemAppend({ connected: true, login: "octocat" }, true);
    expect(s).toContain('as "octocat"');
    expect(s).toContain("ALREADY AUTHENTICATED");
    expect(s).toContain("github_create_repo");
    // The core promise: novices are never sent to the terminal or github.com/new.
    expect(s).toContain("gh auth login");
    expect(s).toMatch(/NEVER tell the user/);
  });

  it("connected but NOT bridged (untrusted folder): tools push app-side, git push is not claimed", () => {
    const s = githubSystemAppend({ connected: true, login: "octocat" }, false);
    expect(s).toContain("NOT authenticated");
    expect(s).not.toContain("ALREADY AUTHENTICATED");
    expect(s).toContain("github_create_repo");
    expect(s).toMatch(/NEVER tell the user/);
  });

  it("not connected: the model is pointed at github_connect first", () => {
    const s = githubSystemAppend({ connected: false });
    expect(s).toContain("NOT connected");
    expect(s).toContain("github_connect");
    expect(s).toContain("github_create_repo");
    expect(s).toMatch(/NEVER tell the user/);
  });

  it("missing status reads as not connected", () => {
    expect(githubSystemAppend(undefined)).toContain("NOT connected");
  });
});

describe("engineModelId", () => {
  it("rides the [1m] variant for 1M-class catalog models", () => {
    expect(engineModelId("claude-sonnet-5")).toBe("claude-sonnet-5[1m]");
    expect(engineModelId("claude-opus-4-8")).toBe("claude-opus-4-8[1m]");
    expect(engineModelId("claude-fable-5")).toBe("claude-fable-5[1m]");
  });

  it("leaves 200K models and unknown ids untouched", () => {
    expect(engineModelId("claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
    expect(engineModelId("some-future-model")).toBe("some-future-model");
  });
});

describe("resolveEffort", () => {
  it("passes low/medium/high through as the native effort param (no thinking cap)", () => {
    expect(resolveEffort("low")).toEqual({ engineEffort: "low", ultra: false });
    expect(resolveEffort("medium")).toEqual({ engineEffort: "medium", ultra: false });
    expect(resolveEffort("high")).toEqual({ engineEffort: "high", ultra: false });
    expect(resolveEffort(undefined)).toEqual({ engineEffort: undefined, ultra: false });
  });

  it("bounds xhigh/max with a thinking budget instead of raw effort (skill-hang fix)", () => {
    // At raw xhigh/max effort a large skill in context sends Opus into a
    // non-terminating think — see resolveEffort. These levels drop `effort` and
    // ride a bounded `thinking` budget, so no `engineEffort` comes back.
    const xhigh = resolveEffort("xhigh");
    expect(xhigh.engineEffort).toBeUndefined();
    expect(xhigh.thinkingBudget).toBeGreaterThan(0);
    expect(xhigh.ultra).toBe(false);

    const max = resolveEffort("max");
    expect(max.engineEffort).toBeUndefined();
    expect(max.thinkingBudget).toBeGreaterThan(0);
    // max reasons at least as deep as xhigh, still finite.
    expect(max.thinkingBudget!).toBeGreaterThanOrEqual(xhigh.thinkingBudget!);
    expect(max.ultra).toBe(false);
  });

  it("runs «Ультра» on a bounded thinking budget plus the orchestration flag", () => {
    const ultra = resolveEffort("ultra");
    expect(ultra.engineEffort).toBeUndefined();
    expect(ultra.thinkingBudget).toBeGreaterThan(0);
    expect(ultra.ultra).toBe(true);
  });
});

describe("workflowProgressAgents", () => {
  // Trimmed from a live task_progress frame (probed 2026-07-14 via the gateway).
  const liveFrame = {
    type: "system",
    subtype: "task_progress",
    task_id: "wo4kq5peh",
    tool_use_id: "toolu_1",
    summary: 'Run two agents in parallel that each return "ping"',
    workflow_progress: [
      { type: "workflow_phase", index: 1, title: "Ping" },
      {
        type: "workflow_agent",
        index: 1,
        label: "ping-1",
        phaseIndex: 1,
        phaseTitle: "Ping",
        agentId: "a98bea",
        model: "claude-sonnet-5",
        state: "done",
        startedAt: 1784065834896,
        lastProgressAt: 1784065836955,
        promptPreview: 'Return the single word "ping" and nothing else.',
        resultPreview: "ping",
        tokens: 29915,
      },
      {
        type: "workflow_agent",
        index: 2,
        label: "ping-2",
        phaseIndex: 1,
        phaseTitle: "Ping",
        agentId: "a3446d",
        model: "claude-sonnet-5",
        state: "start",
        startedAt: 1784065834898,
      },
    ],
  };

  it("extracts the agent roster from a live frame (phases ride along per agent)", () => {
    expect(workflowProgressAgents(liveFrame)).toEqual([
      {
        id: "a98bea",
        label: "ping-1",
        phase: "Ping",
        model: "claude-sonnet-5",
        state: "done",
        promptPreview: 'Return the single word "ping" and nothing else.',
        resultPreview: "ping",
        tokens: 29915,
        startedAt: 1784065834896,
        updatedAt: 1784065836955,
      },
      {
        id: "a3446d",
        label: "ping-2",
        phase: "Ping",
        model: "claude-sonnet-5",
        state: "start",
        promptPreview: undefined,
        resultPreview: undefined,
        tokens: undefined,
        updatedAt: undefined,
        startedAt: 1784065834898,
      },
    ]);
  });

  it("returns null for plain background-task progress and junk", () => {
    expect(workflowProgressAgents({ type: "system", subtype: "task_progress" })).toBeNull();
    expect(workflowProgressAgents({ workflow_progress: [] })).toBeNull();
    expect(
      workflowProgressAgents({ workflow_progress: [{ type: "workflow_phase", title: "X" }] }),
    ).toBeNull();
    expect(workflowProgressAgents(null)).toBeNull();
    expect(workflowProgressAgents("progress")).toBeNull();
  });

  it("falls back to the index when an agent has no id", () => {
    const agents = workflowProgressAgents({
      workflow_progress: [{ type: "workflow_agent", index: 3, state: "start" }],
    });
    expect(agents?.[0]?.id).toBe("3");
  });
});

describe("workflow.progress event contract", () => {
  const envelope = {
    id: "e1",
    schemaVersion: 1 as const,
    type: "workflow.progress",
    timestamp: new Date(0).toISOString(),
    correlationId: "c1",
    taskId: "t1",
    runId: "r1",
  };

  it("accepts a roster snapshot with optional fields absent", () => {
    const event = parseAgentEvent({
      ...envelope,
      data: {
        toolUseId: "toolu_1",
        agents: [{ id: "a1", state: "start" }],
      },
    });
    expect(event.type).toBe("workflow.progress");
  });

  it("rejects an agent without a state", () => {
    expect(() =>
      parseAgentEvent({
        ...envelope,
        data: { toolUseId: "toolu_1", agents: [{ id: "a1" }] },
      }),
    ).toThrow();
  });
});

describe("contextTokensFromUsage", () => {
  it("sums fresh input, cache reads/writes and the answer", () => {
    expect(
      contextTokensFromUsage({
        input_tokens: 1200,
        cache_creation_input_tokens: 3000,
        cache_read_input_tokens: 60000,
        output_tokens: 800,
      }),
    ).toBe(65000);
  });

  it("tolerates partial usage objects", () => {
    expect(contextTokensFromUsage({ input_tokens: 500 })).toBe(500);
    expect(contextTokensFromUsage({ input_tokens: 500, cache_read_input_tokens: null })).toBe(500);
  });

  it("returns null when there is nothing to report", () => {
    expect(contextTokensFromUsage(undefined)).toBeNull();
    expect(contextTokensFromUsage(null)).toBeNull();
    expect(contextTokensFromUsage("usage")).toBeNull();
    expect(contextTokensFromUsage({})).toBeNull();
    expect(contextTokensFromUsage({ input_tokens: 0, output_tokens: 0 })).toBeNull();
    expect(contextTokensFromUsage({ input_tokens: -5 })).toBeNull();
  });
});

describe("pathInsideRoots (auto-allowed read folders)", () => {
  const roots = [normalizeDirPrefix("C:\\Users\\Admin\\AppData\\Roaming\\wello-code\\pastes")];

  it("accepts files inside the root, whatever the case/slashes", () => {
    expect(pathInsideRoots("C:\\Users\\Admin\\AppData\\Roaming\\wello-code\\pastes\\a.png", roots)).toBe(true);
    expect(pathInsideRoots("c:/users/admin/appdata/roaming/WELLO-CODE/pastes/b.jpg", roots)).toBe(true);
  });

  it("rejects siblings and prefix-lookalike folders", () => {
    expect(pathInsideRoots("C:/Users/Admin/AppData/Roaming/wello-code/pastes-evil/x.png", roots)).toBe(false);
    expect(pathInsideRoots("C:/Users/Admin/secrets.txt", roots)).toBe(false);
  });

  it("never fast-paths dot/dot-dot segments (unresolved escape)", () => {
    expect(
      pathInsideRoots("C:/Users/Admin/AppData/Roaming/wello-code/pastes/../../../.ssh/id_rsa", roots),
    ).toBe(false);
    expect(pathInsideRoots("C:/Users/Admin/AppData/Roaming/wello-code/pastes/./a.png", roots)).toBe(false);
  });
});

describe("run.context event contract", () => {
  const envelope = {
    id: "e1",
    schemaVersion: 1 as const,
    type: "run.context",
    timestamp: new Date(0).toISOString(),
    correlationId: "c1",
    taskId: "t1",
    runId: "r1",
  };

  it("accepts either field alone (used tokens now, window later with the result)", () => {
    expect(parseAgentEvent({ ...envelope, data: { usedTokens: 65000 } }).type).toBe("run.context");
    expect(parseAgentEvent({ ...envelope, data: { windowTokens: 200000 } }).type).toBe("run.context");
    expect(parseAgentEvent({ ...envelope, data: {} }).type).toBe("run.context");
  });

  it("rejects non-numeric payloads", () => {
    expect(() => parseAgentEvent({ ...envelope, data: { usedTokens: "many" } })).toThrow();
  });
});

describe("todosFromToolInput (the plan widget feed)", () => {
  it("keeps well-formed items, trims and caps them", () => {
    const items = todosFromToolInput({
      todos: [
        { content: "  Read the repo  ", status: "completed" },
        { content: "Fix the bug", status: "in_progress" },
        { content: "Ship it", status: "pending" },
      ],
    });
    expect(items).toEqual([
      { text: "Read the repo", status: "completed" },
      { text: "Fix the bug", status: "in_progress" },
      { text: "Ship it", status: "pending" },
    ]);
  });

  it("falls back to activeForm, drops garbage, defaults odd statuses to pending", () => {
    const items = todosFromToolInput({
      todos: [
        { activeForm: "Running tests", status: "weird" },
        { content: "" },
        "junk",
        null,
      ],
    });
    expect(items).toEqual([{ text: "Running tests", status: "pending" }]);
  });

  it("returns null without a todos array (no plan frame emitted)", () => {
    expect(todosFromToolInput({})).toBeNull();
    expect(todosFromToolInput({ todos: "all of them" })).toBeNull();
  });

  it("an EMPTY todos array is a valid (cleared) plan, not null", () => {
    expect(todosFromToolInput({ todos: [] })).toEqual([]);
  });
});

describe("taskIdFromCreateResult (TaskCreate → plan item id)", () => {
  it("parses the id out of the engine's confirmation", () => {
    expect(taskIdFromCreateResult("Task #7 created successfully: Fix the bug")).toBe("7");
    expect(taskIdFromCreateResult("Task 12 created")).toBe("12");
  });

  it("returns null when no id is present", () => {
    expect(taskIdFromCreateResult("created ok")).toBeNull();
    expect(taskIdFromCreateResult("")).toBeNull();
  });
});
