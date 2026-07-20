import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@wello-code/contracts";
import {
  agentReducer,
  describeCurrentAction,
  initialAgentState,
  type AgentState,
} from "./agent-state";

let seq = 0;
function ev(type: string, data: unknown, timestamp = "2026-07-14T12:00:00.000Z"): AgentEvent {
  return {
    id: `e${++seq}`,
    schemaVersion: 1,
    type,
    timestamp,
    correlationId: "c1",
    taskId: "t1",
    runId: "r1",
    data,
  } as AgentEvent;
}

function apply(state: AgentState, ...events: AgentEvent[]): AgentState {
  return events.reduce((s, e) => agentReducer(s, { type: "event", event: e }), state);
}

const workflowRequested = ev("tool.requested", {
  id: "toolu_wf",
  runId: "r1",
  intent: { kind: "run_command", argv: ["Workflow"], cwd: "/w" },
  summary: "Workflow · double-ping",
  status: "running",
  risk: "low",
  idempotencyKey: "toolu_wf",
});

const snapshot = (agents: unknown[]) =>
  ev("workflow.progress", { toolUseId: "toolu_wf", summary: "ping", agents });

describe("agentReducer · workflow fleet", () => {
  it("marks a Workflow step with the subagent icon without adding it to the fleet list", () => {
    const state = apply(initialAgentState, workflowRequested);
    const item = state.items.find((i) => i.kind === "tool" && i.id === "toolu_wf");
    expect(item && item.kind === "tool" ? item.icon : null).toBe("subagent");
    expect(state.subagents).toHaveLength(0);
  });

  it("builds synthetic subagents from a roster snapshot (phase-qualified titles, previews as transcript)", () => {
    const state = apply(
      initialAgentState,
      workflowRequested,
      snapshot([
        {
          id: "a1",
          label: "ping-1",
          phase: "Ping",
          state: "done",
          promptPreview: "Return ping.",
          resultPreview: "ping",
          startedAt: 1784065834896,
          updatedAt: 1784065836955,
        },
        { id: "a2", label: "ping-2", phase: "Ping", state: "start" },
      ]),
    );
    expect(state.subagents).toHaveLength(2);
    const [done, running] = state.subagents;
    expect(done).toMatchObject({
      id: "wf:toolu_wf:a1",
      title: "Ping · ping-1",
      status: "done",
      transcript: [
        { entry: "text", text: "Return ping." },
        { entry: "text", text: "ping" },
      ],
    });
    expect(done!.finishedAt).toBe(new Date(1784065836955).toISOString());
    expect(running).toMatchObject({ id: "wf:toolu_wf:a2", status: "running", transcript: [] });
  });

  it("replaces the roster on each snapshot instead of duplicating it", () => {
    const state = apply(
      initialAgentState,
      workflowRequested,
      snapshot([{ id: "a1", label: "ping-1", state: "start" }]),
      snapshot([
        { id: "a1", label: "ping-1", state: "done", resultPreview: "ping" },
        { id: "a2", label: "ping-2", state: "start" },
      ]),
    );
    expect(state.subagents.map((s) => s.id)).toEqual(["wf:toolu_wf:a1", "wf:toolu_wf:a2"]);
    expect(state.subagents[0]!.status).toBe("done");
  });

  it("keeps unrelated subagents intact across workflow snapshots", () => {
    const agentRequested = ev("tool.requested", {
      id: "toolu_plain",
      runId: "r1",
      intent: { kind: "run_command", argv: ["Agent"], cwd: "/w" },
      summary: "Subagent · Explore the repo",
      status: "running",
      risk: "low",
      idempotencyKey: "toolu_plain",
    });
    const state = apply(
      initialAgentState,
      agentRequested,
      workflowRequested,
      snapshot([{ id: "a1", state: "start" }]),
    );
    expect(state.subagents.map((s) => s.id)).toEqual(["toolu_plain", "wf:toolu_wf:a1"]);
  });

  it("settles the remaining fleet when the workflow's own tool settles (mid-flight failure)", () => {
    const state = apply(
      initialAgentState,
      workflowRequested,
      snapshot([
        { id: "a1", label: "ping-1", state: "done" },
        { id: "a2", label: "ping-2", state: "start" },
      ]),
      ev("tool.updated", { id: "toolu_wf", status: "failed" }),
    );
    const byId = Object.fromEntries(state.subagents.map((s) => [s.id, s.status]));
    expect(byId["wf:toolu_wf:a1"]).toBe("done");
    expect(byId["wf:toolu_wf:a2"]).toBe("failed");
  });

  it("maps an agent error state to a failed subagent", () => {
    const state = apply(
      initialAgentState,
      workflowRequested,
      snapshot([{ id: "a1", label: "ping-1", state: "error" }]),
    );
    expect(state.subagents[0]!.status).toBe("failed");
  });
});

describe("describeCurrentAction", () => {
  const toolReq = (id: string, kind: string) =>
    ev("tool.requested", {
      id,
      runId: "r1",
      intent: { kind },
      summary: `x ${id}`,
      status: "running",
      risk: "low",
      idempotencyKey: id,
    });

  it("names the running tool by its icon", () => {
    const s = apply(initialAgentState, toolReq("t1", "read_file"));
    expect(describeCurrentAction(s.items, true)).toBe("Читаю файлы…");
    const s2 = apply(initialAgentState, toolReq("t2", "run_command"));
    expect(describeCurrentAction(s2.items, true)).toBe("Запускаю команду…");
  });

  it("shows «Печатаю ответ…» while the answer streams", () => {
    const s = apply(initialAgentState, ev("message.delta", { messageId: "m1", text: "hi" }));
    expect(describeCurrentAction(s.items, true)).toBe("Печатаю ответ…");
  });

  it("falls back to «Думает…» on a silent turn", () => {
    expect(describeCurrentAction([], true)).toBe("Думает…");
  });

  it("returns null when not running", () => {
    const s = apply(initialAgentState, toolReq("t1", "read_file"));
    expect(describeCurrentAction(s.items, false)).toBeNull();
  });
});

describe("agentReducer · recovered status", () => {
  it("passes a recovered tool status onto the tool item", () => {
    const req = ev("tool.requested", {
      id: "t1",
      runId: "r1",
      intent: { kind: "apply_patch" },
      summary: "Write x",
      status: "running",
      risk: "medium",
      idempotencyKey: "t1",
    });
    const s = apply(initialAgentState, req, ev("tool.updated", { id: "t1", status: "recovered" }));
    const t = s.items.find((i) => i.kind === "tool" && i.id === "t1");
    expect(t && t.kind === "tool" ? t.status : null).toBe("recovered");
  });
});

describe("agentReducer · plan widget (plan.updated)", () => {
  it("replaces the plan with every snapshot and clears it on a new task", () => {
    let state = agentReducer(initialAgentState, { type: "start", prompt: "go" });
    state = apply(state, ev("plan.updated", { items: [{ text: "step 1", status: "pending" }] }));
    expect(state.plan).toEqual([{ text: "step 1", status: "pending" }]);
    state = apply(
      state,
      ev("plan.updated", {
        items: [
          { text: "step 1", status: "completed" },
          { text: "step 2", status: "in_progress" },
        ],
      }),
    );
    expect(state.plan).toHaveLength(2);
    expect(state.plan?.[0]?.status).toBe("completed");
    const fresh = agentReducer(state, { type: "start", prompt: "next task" });
    expect(fresh.plan).toBeNull();
  });

  it("a follow-up keeps the plan (the agent updates it itself)", () => {
    let state = agentReducer(initialAgentState, { type: "start", prompt: "go" });
    state = apply(state, ev("plan.updated", { items: [{ text: "a", status: "completed" }] }));
    state = agentReducer(state, { type: "followup", prompt: "more" });
    expect(state.plan).toHaveLength(1);
  });
});

describe("agentReducer · editTurn (fork an earlier turn)", () => {
  function seed(): AgentState {
    let state = agentReducer(initialAgentState, { type: "start", prompt: "first ask" });
    state = apply(
      state,
      ev("message.completed", { messageId: "m1", summary: "first answer", sdkUuid: "uuid-1" }),
    );
    state = agentReducer(state, { type: "followup", prompt: "second ask" });
    state = apply(
      state,
      ev("message.completed", { messageId: "m2", summary: "second answer", sdkUuid: "uuid-2" }),
    );
    return state;
  }

  it("truncates at the edited user turn and appends the corrected message", () => {
    const state = seed();
    const secondUser = state.items.filter((i) => i.kind === "user")[1]!;
    const next = agentReducer(state, {
      type: "editTurn",
      itemId: secondUser.id,
      prompt: "second ask, fixed",
    });
    const kinds = next.items.map((i) => i.kind);
    expect(kinds).toEqual(["user", "message", "user"]);
    const last = next.items[next.items.length - 1]!;
    expect(last.kind === "user" ? last.text : null).toBe("second ask, fixed");
    expect(next.running).toBe(true);
    expect(next.plan).toBeNull();
  });

  it("keeps the sdkUuid of surviving assistant messages (the fork anchor)", () => {
    const state = seed();
    const secondUser = state.items.filter((i) => i.kind === "user")[1]!;
    const next = agentReducer(state, {
      type: "editTurn",
      itemId: secondUser.id,
      prompt: "fixed",
    });
    const msg = next.items.find((i) => i.kind === "message");
    expect(msg && msg.kind === "message" ? msg.sdkUuid : null).toBe("uuid-1");
  });

  it("editing the FIRST turn empties the history before the new message", () => {
    const state = seed();
    const firstUser = state.items.filter((i) => i.kind === "user")[0]!;
    const next = agentReducer(state, {
      type: "editTurn",
      itemId: firstUser.id,
      prompt: "restart",
    });
    expect(next.items.map((i) => i.kind)).toEqual(["user"]);
  });
});

describe("agentReducer · github_connect card lifecycle", () => {
  it("connect_requested raises the card; resolve clears it", () => {
    const state = apply(initialAgentState, ev("github.connect_requested", { id: "gh1", runId: "r1" }));
    expect(state.githubConnect).toEqual({ id: "gh1", runId: "r1" });
    const cleared = agentReducer(state, { type: "resolveGithubConnect" });
    expect(cleared.githubConnect).toBeNull();
  });

  it("terminal run events never leave the card hanging", () => {
    const raised = apply(initialAgentState, ev("github.connect_requested", { id: "gh1", runId: "r1" }));
    expect(apply(raised, ev("run.completed", { summary: "done" })).githubConnect).toBeNull();
    expect(
      apply(raised, ev("run.failed", { code: "runtime_error", message: "x", retryable: true }))
        .githubConnect,
    ).toBeNull();
    expect(
      apply(raised, ev("run.status_changed", { from: "working", to: "cancelled" })).githubConnect,
    ).toBeNull();
    expect(agentReducer(raised, { type: "cancelLocal" }).githubConnect).toBeNull();
  });
});

describe("agentReducer · plan finalization on run end", () => {
  const planned = apply(
    initialAgentState,
    ev("plan.updated", {
      items: [
        { text: "Шаг 1", status: "completed" },
        { text: "Шаг 2", status: "completed" },
        { text: "Pre-flight аудит и пуш", status: "in_progress" },
      ],
    }),
  );

  it("a successful run completes the item the model forgot to close", () => {
    const done = apply(planned, ev("run.completed", { summary: "Запушено" }));
    expect(done.plan?.map((p) => p.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("failure and cancel return in-progress to pending (never claim it ran)", () => {
    const failed = apply(
      planned,
      ev("run.failed", { code: "runtime_error", message: "x", retryable: true }),
    );
    expect(failed.plan?.map((p) => p.status)).toEqual(["completed", "completed", "pending"]);
    const cancelled = apply(
      planned,
      ev("run.status_changed", { from: "working", to: "cancelled" }),
    );
    expect(cancelled.plan?.map((p) => p.status)).toEqual(["completed", "completed", "pending"]);
    const local = agentReducer(planned, { type: "cancelLocal" });
    expect(local.plan?.map((p) => p.status)).toEqual(["completed", "completed", "pending"]);
  });

  it("pending items stay pending on success (an unfinished plan is not lied about)", () => {
    const partial = apply(
      initialAgentState,
      ev("plan.updated", {
        items: [
          { text: "Шаг 1", status: "in_progress" },
          { text: "Шаг 2", status: "pending" },
        ],
      }),
      ev("run.completed", { summary: "done" }),
    );
    expect(partial.plan?.map((p) => p.status)).toEqual(["completed", "pending"]);
  });
});
