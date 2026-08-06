import { describe, expect, it } from "vitest";
import { parseAgentEvent } from "@wello-code/contracts";
import {
  classifyFailure,
  contextTokensFromUsage,
  engineFingerprint,
  engineModelId,
  githubSystemAppend,
  normalizeDirPrefix,
  pathInsideRoots,
  resolveEffort,
  runSettings,
  taskIdFromCreateResult,
  todosFromToolInput,
  workflowProgressAgents,
} from "./session";

describe("githubSystemAppend (the anti-'gh auth login' steering)", () => {
  it("connected + bridged: git is authenticated, publish via github_create_repo", () => {
    const s = githubSystemAppend({ connected: true, login: "octocat" }, true);
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

  // The prompt cache keys on the system prompt: a line that can differ between
  // two turns of one conversation throws away the whole cached prefix. The
  // account name is fetched from github.com and may not be known on the first
  // turn, so it must not appear here.
  it("says the same thing whether or not the account name is known", () => {
    expect(githubSystemAppend({ connected: true, login: "octocat" }, true)).toBe(
      githubSystemAppend({ connected: true }, true),
    );
    expect(githubSystemAppend({ connected: true, login: "octocat" }, false)).toBe(
      githubSystemAppend({ connected: true }, false),
    );
  });
});

describe("engineModelId", () => {
  it("rides the [1m] variant for 1M-class catalog models", () => {
    expect(engineModelId("claude-sonnet-5")).toBe("claude-sonnet-5[1m]");
    expect(engineModelId("claude-opus-5")).toBe("claude-opus-5[1m]");
    expect(engineModelId("claude-opus-4-8")).toBe("claude-opus-4-8[1m]");
    expect(engineModelId("claude-fable-5")).toBe("claude-fable-5[1m]");
  });

  it("leaves 200K models and unknown ids untouched", () => {
    expect(engineModelId("claude-sonnet-4.6")).toBe("claude-sonnet-4.6");
    expect(engineModelId("some-future-model")).toBe("some-future-model");
  });

  it("sends the GPT family clean: it holds 400K, not 1M", () => {
    // The "[1m]" variant is an engine-internal name for ITS table of Anthropic
    // models. Handing it a GPT id would either be ignored or, worse, understood
    // as a 1M window the model does not have. Their window is set on our side
    // (renderer/models.ts), which is where the ring reads it.
    for (const id of ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"]) {
      expect(engineModelId(id)).toBe(id);
    }
  });
});

describe("runSettings (auto-compaction budget)", () => {
  it("defaults to a bounded budget instead of the model's whole window", () => {
    // Without this the 1M "[1m]" variant pushed auto-compaction to ~1M tokens,
    // i.e. effectively never — which is how a month's plan went on re-read context.
    const s = runSettings(undefined, false);
    expect(s.autoCompactEnabled).toBe(true);
    expect(s.autoCompactWindow).toBe(200_000);
  });

  it("honours the user's own budget", () => {
    expect(runSettings(400_000, false).autoCompactWindow).toBe(400_000);
  });

  it("0 means NEVER compact — the full window is the point of a 1M model", () => {
    const s = runSettings(0, false);
    expect(s.autoCompactEnabled).toBe(false);
    // No budget is sent at all: an autoCompactWindow with compaction off would
    // be a contradiction for the engine to resolve.
    expect(s.autoCompactWindow).toBeUndefined();
  });

  it("keeps the Ультра flags alongside the compaction choice", () => {
    const s = runSettings(0, true);
    expect(s.ultracode).toBe(true);
    expect(s.enableWorkflows).toBe(true);
    expect(s.autoCompactEnabled).toBe(false);
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

describe("engineFingerprint (what a warmed engine may be reused for)", () => {
  const conn = { apiKey: "wlo_live_key", appVersion: "0.1.11" };
  const base = {
    taskId: "t1",
    runId: "r1",
    workspaceId: "t1",
    workspacePath: "C:/proj",
    mode: "manual" as const,
    prompt: "первый вопрос",
    model: "claude-sonnet-5",
    effort: "high" as const,
  };

  it("ignores what a turn brings with it — that is the whole point", () => {
    // The engine is spawned before the message exists; a warmed one must serve
    // whatever the user ends up typing.
    const other = { ...base, prompt: "совсем другой вопрос", runId: "r2", taskId: "t2" };
    expect(engineFingerprint(other, conn)).toBe(engineFingerprint(base, conn));
  });

  it("changes with anything the engine bakes in at spawn", () => {
    const fp = engineFingerprint(base, conn);
    expect(engineFingerprint({ ...base, model: "claude-opus-5" }, conn)).not.toBe(fp);
    expect(engineFingerprint({ ...base, mode: "auto" }, conn)).not.toBe(fp);
    expect(engineFingerprint({ ...base, effort: "low" }, conn)).not.toBe(fp);
    expect(engineFingerprint({ ...base, workspacePath: "C:/other" }, conn)).not.toBe(fp);
    expect(engineFingerprint({ ...base, trusted: true }, conn)).not.toBe(fp);
    expect(engineFingerprint({ ...base, skills: ["design"] }, conn)).not.toBe(fp);
    expect(engineFingerprint({ ...base, resumeSessionId: "s1" }, conn)).not.toBe(fp);
    // A fork loads a different history — never reuse an engine across one.
    expect(engineFingerprint({ ...base, resumeAtMessageUuid: "u1" }, conn)).not.toBe(fp);
    expect(engineFingerprint(base, { ...conn, apiKey: "wlo_live_other" })).not.toBe(fp);
    // Credentials are baked into the engine's environment at spawn: a warmed
    // process still carries the old one, so a rotated one must not reuse it.
    expect(engineFingerprint({ ...base, gitEnv: { GIT_CONFIG_VALUE_0: "t1" } }, conn)).not.toBe(
      engineFingerprint({ ...base, gitEnv: { GIT_CONFIG_VALUE_0: "t2" } }, conn),
    );
  });

  it("does not care about the ORDER of skills", () => {
    const a = { ...base, skills: ["one", "two"] };
    const b = { ...base, skills: ["two", "one"] };
    expect(engineFingerprint(a, conn)).toBe(engineFingerprint(b, conn));
  });

  it("ignores grants entirely — the permission callback reads them live", () => {
    // A grant made while a warmed engine already existed must not cost the
    // user the warm start: canUseTool resolves grants through the live turn,
    // so the fingerprint has no business varying on them.
    expect(engineFingerprint({ ...base, workspaceGrants: ["write"] }, conn)).toBe(
      engineFingerprint(base, conn),
    );
    expect(engineFingerprint({ ...base, taskGrants: ["command"] }, conn)).toBe(
      engineFingerprint(base, conn),
    );
  });

  it("never carries the key itself", () => {
    expect(engineFingerprint(base, conn)).not.toContain("wlo_live");
  });
});

describe("classifyFailure (RU error card + retryability)", () => {
  it("subscription cap before the generic 402 branch", () => {
    const f = classifyFailure("HTTP 402: subscription_cap reached");
    expect(f.code).toBe("subscription_limit");
    expect(f.retryable).toBe(false);
  });

  it("names an upstream 5xx as a passing service hiccup, retryable", () => {
    // The engine surfaces these as e.g. «API Error: 503 Upstream error. This is
    // a server-side issue…» — the card must say «попробуйте ещё раз», not the
    // anonymous «произошла ошибка» (which reads as a bug in the app).
    for (const raw of [
      "API Error: 503 Upstream error. This is a server-side issue",
      "error_during_execution — API Error: 529 overloaded_error",
      "502 Bad Gateway",
    ]) {
      const f = classifyFailure(raw);
      expect(f.code).toBe("upstream_error");
      expect(f.retryable).toBe(true);
    }
  });

  it("keeps balance exhaustion non-retryable (402 wins over any 5xx words)", () => {
    const f = classifyFailure("402 payment required: prepaid balance too low");
    expect(f.code).toBe("insufficient_balance");
    expect(f.retryable).toBe(false);
  });

  it("still falls back to the generic runtime error", () => {
    const f = classifyFailure("error_during_execution");
    expect(f.code).toBe("runtime_error");
    expect(f.retryable).toBe(true);
  });
});
