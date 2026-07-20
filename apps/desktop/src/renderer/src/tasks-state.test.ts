import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@wello-code/contracts";
import {
  groupTasks,
  initialTasksState,
  taskActivityMs,
  tasksReducer,
  type TaskItem,
  type TasksState,
} from "./tasks-state";
import { initialAgentState } from "./agent-state";

function makeEvent(type: string, runId: string, data: unknown): AgentEvent {
  return {
    id: crypto.randomUUID(),
    schemaVersion: 1,
    type,
    timestamp: new Date().toISOString(),
    correlationId: crypto.randomUUID(),
    taskId: "a",
    runId,
    data,
  } as AgentEvent;
}

const DAY = 86_400_000;
// A fixed "now": 12:00 local time, so day-boundary math is unambiguous.
const base = new Date();
const NOW = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 12).getTime();

function makeTask(id: string, over: Partial<TaskItem> = {}): TaskItem {
  return {
    id,
    title: id,
    prompt: id,
    mode: "manual",
    runId: null,
    sessionId: null,
    workspacePath: "C:/w",
    workspaceName: "w",
    pinned: false,
    agent: initialAgentState,
    changes: null,
    ...over,
  };
}

function create(state: TasksState, id: string, images?: string[]): TasksState {
  return tasksReducer(state, {
    type: "create",
    id,
    title: id,
    prompt: id,
    mode: "manual",
    runId: `run-${id}`,
    workspacePath: "C:/w",
    workspaceName: "w",
    images,
  });
}

describe("groupTasks", () => {
  it("buckets by activity: pinned, today, yesterday, week, earlier", () => {
    const tasks: TaskItem[] = [
      makeTask("pin", { pinned: true, updatedAt: new Date(NOW - 30 * DAY).toISOString() }),
      makeTask("today", { updatedAt: new Date(NOW - 1000).toISOString() }),
      makeTask("yesterday", { updatedAt: new Date(NOW - DAY).toISOString() }),
      makeTask("week", { updatedAt: new Date(NOW - 3 * DAY).toISOString() }),
      makeTask("earlier", { updatedAt: new Date(NOW - 20 * DAY).toISOString() }),
    ];
    const groups = groupTasks(tasks, NOW);
    expect(groups.map((g) => g.key)).toEqual(["pinned", "today", "yesterday", "week", "earlier"]);
    expect(groups.map((g) => g.tasks.map((t) => t.id))).toEqual([
      ["pin"],
      ["today"],
      ["yesterday"],
      ["week"],
      ["earlier"],
    ]);
  });

  it("keeps the pinned block in manual order but sorts the rest newest-first", () => {
    const tasks: TaskItem[] = [
      makeTask("pin-b", { pinned: true, updatedAt: new Date(NOW - 5 * DAY).toISOString() }),
      makeTask("pin-a", { pinned: true, updatedAt: new Date(NOW).toISOString() }),
      makeTask("old", { updatedAt: new Date(NOW - 2000).toISOString() }),
      makeTask("new", { updatedAt: new Date(NOW - 1000).toISOString() }),
    ];
    const groups = groupTasks(tasks, NOW);
    expect(groups[0]!.tasks.map((t) => t.id)).toEqual(["pin-b", "pin-a"]);
    expect(groups[1]!.tasks.map((t) => t.id)).toEqual(["new", "old"]);
  });

  it("drops tasks without any timestamp into the earlier band", () => {
    const groups = groupTasks([makeTask("legacy")], NOW);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.key).toBe("earlier");
    expect(taskActivityMs(makeTask("legacy"))).toBe(0);
  });

  it("omits empty bands entirely", () => {
    const groups = groupTasks([makeTask("t", { updatedAt: new Date(NOW).toISOString() })], NOW);
    expect(groups.map((g) => g.key)).toEqual(["today"]);
  });
});

describe("tasksReducer", () => {
  it("stamps updatedAt and threads images through create and followup", () => {
    let state = create(initialTasksState, "a", ["C:/img/one.png"]);
    const created = state.tasks[0]!;
    expect(created.updatedAt).toBeTruthy();
    const firstTurn = created.agent.items[0]!;
    expect(firstTurn.kind === "user" && firstTurn.images).toEqual(["C:/img/one.png"]);

    state = tasksReducer(state, {
      type: "followup",
      taskId: "a",
      prompt: "next",
      runId: "run-2",
      mode: "manual",
      images: ["C:/img/two.png"],
    });
    const items = state.tasks[0]!.agent.items;
    const lastTurn = items[items.length - 1]!;
    expect(lastTurn.kind === "user" && lastTurn.images).toEqual(["C:/img/two.png"]);
  });

  it("threads attachment chips and the retry fullText through the user turn", () => {
    const state = tasksReducer(initialTasksState, {
      type: "create",
      id: "a",
      title: "a",
      prompt: "глянь файл",
      mode: "manual",
      runId: "run-a",
      workspacePath: "C:/w",
      workspaceName: "w",
      attachments: [{ kind: "file", label: "report.pdf" }],
      fullText: "глянь файл\n\nПрикреплённые файлы...",
    });
    const turn = state.tasks[0]!.agent.items[0]!;
    expect(turn.kind).toBe("user");
    if (turn.kind === "user") {
      expect(turn.text).toBe("глянь файл");
      expect(turn.attachments).toEqual([{ kind: "file", label: "report.pdf" }]);
      expect(turn.fullText).toContain("Прикреплённые файлы");
    }
  });

  it("cancelLocal settles the UI instantly and mutes the cancelled run's late events", () => {
    let state = create(initialTasksState, "a");
    state = tasksReducer(state, { type: "cancelLocal", taskId: "a" });
    const t = state.tasks[0]!;
    expect(t.agent.running).toBe(false);
    expect(t.runId).toBeNull();
    expect(t.cancelledRunId).toBe("run-a");
    const items = t.agent.items;
    const last = items[items.length - 1]!;
    expect(last.kind === "note" && last.text).toBe("Запуск отменён");

    // A late delta from the cancelled run must not reanimate or append anything.
    state = tasksReducer(state, {
      type: "event",
      event: makeEvent("message.delta", "run-a", { messageId: "m1", text: "поздний токен" }),
    });
    expect(state.tasks[0]!.agent.items).toHaveLength(items.length);
    expect(state.tasks[0]!.agent.running).toBe(false);

    // The engine's own duplicate "cancelled" note is muted too.
    state = tasksReducer(state, {
      type: "event",
      event: makeEvent("run.status_changed", "run-a", { from: "working", to: "cancelled" }),
    });
    expect(state.tasks[0]!.agent.items).toHaveLength(items.length);

    // But the session handle still lands — the next turn can resume.
    state = tasksReducer(state, {
      type: "event",
      event: makeEvent("run.session_started", "run-a", { sessionId: "s-1" }),
    });
    expect(state.tasks[0]!.sessionId).toBe("s-1");

    // A fresh follow-up clears the muting and streams normally again.
    state = tasksReducer(state, {
      type: "followup",
      taskId: "a",
      prompt: "ещё раз",
      runId: "run-b",
      mode: "manual",
    });
    expect(state.tasks[0]!.cancelledRunId).toBeNull();
    const count = state.tasks[0]!.agent.items.length;
    state = tasksReducer(state, {
      type: "event",
      event: makeEvent("message.delta", "run-b", { messageId: "m2", text: "живой токен" }),
    });
    expect(state.tasks[0]!.agent.items.length).toBe(count + 1);
  });

  it("reorderPinned reorders only the pinned block and survives stale ids", () => {
    let state = create(create(create(initialTasksState, "c"), "b"), "a");
    state = tasksReducer(state, { type: "setPinned", taskId: "a", pinned: true });
    state = tasksReducer(state, { type: "setPinned", taskId: "b", pinned: true });
    expect(state.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);

    state = tasksReducer(state, { type: "reorderPinned", ids: ["b", "a", "ghost"] });
    expect(state.tasks.map((t) => t.id)).toEqual(["b", "a", "c"]);

    // Ids that skip a pinned task must not lose it.
    state = tasksReducer(state, { type: "reorderPinned", ids: ["a"] });
    expect(state.tasks.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(state.tasks.filter((t) => t.pinned).map((t) => t.id)).toEqual(["a", "b"]);
  });
});
