import type { AgentEvent, TaskMode } from "@wello-code/contracts";
import type { ChangeSummary } from "../../shared/ipc-api";
import {
  agentReducer,
  finalizePlan,
  initialAgentState,
  type AgentState,
  type TimelineItem,
  type UserTurnPayload,
} from "./agent-state";

/** A run cut off by an app close — restored history alone looks truncated/broken. */
function interruptedNote(taskId: string): TimelineItem {
  return {
    kind: "note",
    id: `note-interrupted-${taskId}`,
    text: "Задача была прервана при закрытии приложения. Отправьте сообщение, чтобы продолжить.",
    tone: "info",
  };
}
function endsWithInterrupted(items: TimelineItem[] | undefined): boolean {
  const last = items?.[items.length - 1];
  return last?.kind === "note" && last.id.startsWith("note-interrupted-");
}

/** One agent task (a multi-turn conversation) with its own timeline. */
export interface TaskItem {
  id: string;
  title: string;
  prompt: string;
  mode: TaskMode;
  runId: string | null;
  /** Engine session id — the resume handle for follow-up turns. */
  sessionId: string | null;
  /** Workspace this chat is bound to (chosen at creation; each chat has its own). */
  workspacePath: string | null;
  workspaceName?: string | null;
  /** Pinned chats sort to the top of the sidebar. */
  pinned?: boolean;
  /** Last user activity (create/follow-up) — drives the date groups in the sidebar. */
  updatedAt?: string;
  /** Run the user cancelled locally — its late engine events are muted (except session id). */
  cancelledRunId?: string | null;
  agent: AgentState;
  /** Uncommitted workspace changes captured when the run finished (change-set card). */
  changes: ChangeSummary | null;
}

export interface TasksState {
  tasks: TaskItem[];
  activeId: string | null;
}

export const initialTasksState: TasksState = { tasks: [], activeId: null };

export type TasksAction =
  | ({
      type: "create";
      id: string;
      title: string;
      mode: TaskMode;
      runId: string;
      workspacePath: string;
      workspaceName: string;
    } & UserTurnPayload)
  | ({
      type: "followup";
      taskId: string;
      runId: string;
      mode: TaskMode;
    } & UserTurnPayload)
  | ({
      type: "editTurn";
      taskId: string;
      itemId: string;
      runId: string;
      mode: TaskMode;
    } & UserTurnPayload)
  | { type: "cancelLocal"; taskId: string }
  | { type: "hydrate"; tasks: TaskItem[]; activeId: string | null }
  | { type: "rename"; taskId: string; title: string }
  | { type: "setPinned"; taskId: string; pinned: boolean }
  | { type: "reorderPinned"; ids: string[] }
  | { type: "delete"; taskId: string }
  | { type: "setActive"; id: string | null }
  | { type: "resolvePermission"; taskId: string }
  | { type: "resolveQuestion"; taskId: string }
  | { type: "resolveGithubConnect"; taskId: string }
  | { type: "setChanges"; taskId: string; changes: ChangeSummary | null }
  | { type: "event"; event: AgentEvent };

export function tasksReducer(state: TasksState, action: TasksAction): TasksState {
  switch (action.type) {
    case "create": {
      const task: TaskItem = {
        id: action.id,
        title: action.title,
        prompt: action.prompt,
        mode: action.mode,
        runId: action.runId,
        sessionId: null,
        workspacePath: action.workspacePath,
        workspaceName: action.workspaceName,
        pinned: false,
        updatedAt: new Date().toISOString(),
        cancelledRunId: null,
        agent: agentReducer(initialAgentState, {
          type: "start",
          prompt: action.prompt,
          images: action.images,
          attachments: action.attachments,
          fullText: action.fullText,
          runId: action.runId,
        }),
        changes: null,
      };
      // New chats land right below the pinned block.
      const pinnedTasks = state.tasks.filter((t) => t.pinned);
      const rest = state.tasks.filter((t) => !t.pinned);
      return { tasks: [...pinnedTasks, task, ...rest], activeId: action.id };
    }
    case "followup":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        runId: action.runId,
        mode: action.mode,
        changes: null,
        updatedAt: new Date().toISOString(),
        cancelledRunId: null,
        agent: agentReducer(t.agent, {
          type: "followup",
          prompt: action.prompt,
          images: action.images,
          attachments: action.attachments,
          fullText: action.fullText,
          runId: action.runId,
        }),
      }));
    case "editTurn":
      // The engine forks at the pre-edit anchor; run.session_started of the new
      // run delivers the forked session id (the current one stays valid until).
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        runId: action.runId,
        mode: action.mode,
        changes: null,
        updatedAt: new Date().toISOString(),
        cancelledRunId: null,
        agent: agentReducer(t.agent, {
          type: "editTurn",
          itemId: action.itemId,
          prompt: action.prompt,
          images: action.images,
          attachments: action.attachments,
          fullText: action.fullText,
          runId: action.runId,
        }),
      }));
    case "cancelLocal":
      // Instant Stop: settle the UI now; the engine's late events for this run
      // are muted below (the session id is still welcome — it enables resume).
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        cancelledRunId: t.runId,
        runId: null,
        agent: agentReducer(t.agent, { type: "cancelLocal" }),
      }));
    case "hydrate":
      // The engine process did not survive the restart, so no task is truly
      // mid-run. If one WAS running when the app closed, leave a note so the
      // truncated turn isn't mistaken for a finished (or broken) answer.
      return {
        activeId: action.activeId,
        tasks: action.tasks.map((t) => {
          const wasRunning = t.agent.running === true;
          const items =
            wasRunning && !endsWithInterrupted(t.agent.items)
              ? [...(t.agent.items ?? []), interruptedNote(t.id)]
              : t.agent.items;
          return {
            ...t,
            runId: null,
            agent: {
              ...t.agent,
              items,
              running: false,
              pending: null,
              question: null,
              githubConnect: null,
              subagents: (t.agent.subagents ?? []).map((s) =>
                s.status === "running" ? { ...s, status: "done" as const } : s,
              ),
              // Snapshots from builds without the context gauge.
              contextUsedTokens: t.agent.contextUsedTokens ?? null,
              contextWindowTokens: t.agent.contextWindowTokens ?? null,
              lastFailure: t.agent.lastFailure ?? null,
              // The engine died with the app — an "in progress" plan item is as
              // stale as `running`; back to pending, matching the note above.
              plan: finalizePlan(t.agent.plan ?? null, "pending"),
            },
          };
        }),
      };
    case "rename":
      return mapTask(state, action.taskId, (t) => ({ ...t, title: action.title }));
    case "setPinned": {
      const next = state.tasks.map((t) =>
        t.id === action.taskId ? { ...t, pinned: action.pinned } : t,
      );
      // Keep the pinned block on top, preserving relative order inside each group.
      return { ...state, tasks: [...next.filter((t) => t.pinned), ...next.filter((t) => !t.pinned)] };
    }
    case "reorderPinned": {
      // Drag-to-reorder within the pinned block: the ids carry the new order.
      const byId = new Map(state.tasks.map((t) => [t.id, t]));
      const ordered = action.ids
        .map((id) => byId.get(id))
        .filter((t): t is TaskItem => Boolean(t?.pinned));
      const leftovers = state.tasks.filter((t) => t.pinned && !action.ids.includes(t.id));
      const rest = state.tasks.filter((t) => !t.pinned);
      return { ...state, tasks: [...ordered, ...leftovers, ...rest] };
    }
    case "delete": {
      const tasks = state.tasks.filter((t) => t.id !== action.taskId);
      return { tasks, activeId: state.activeId === action.taskId ? null : state.activeId };
    }
    case "setActive":
      return { ...state, activeId: action.id };
    case "resolvePermission":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        agent: agentReducer(t.agent, { type: "resolvePermission" }),
      }));
    case "resolveQuestion":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        agent: agentReducer(t.agent, { type: "resolveQuestion" }),
      }));
    case "resolveGithubConnect":
      return mapTask(state, action.taskId, (t) => ({
        ...t,
        agent: agentReducer(t.agent, { type: "resolveGithubConnect" }),
      }));
    case "setChanges":
      return mapTask(state, action.taskId, (t) => ({ ...t, changes: action.changes }));
    case "event": {
      const taskId = action.event.taskId;
      if (!taskId) return state;
      // The session handle lives on the task (it outlives individual runs) —
      // kept even for cancelled runs, so the next turn can resume.
      if (action.event.type === "run.session_started") {
        const sessionId = action.event.data.sessionId;
        return mapTask(state, taskId, (t) => ({ ...t, sessionId }));
      }
      return mapTask(state, taskId, (t) => {
        // A locally-cancelled run's stragglers (deltas, its own "cancelled"
        // status) must not reanimate or duplicate the already-settled UI.
        if (t.cancelledRunId && action.event.runId === t.cancelledRunId) return t;
        return {
          ...t,
          agent: agentReducer(t.agent, { type: "event", event: action.event }),
        };
      });
    }
  }
}

function mapTask(state: TasksState, id: string, fn: (t: TaskItem) => TaskItem): TasksState {
  return { ...state, tasks: state.tasks.map((t) => (t.id === id ? fn(t) : t)) };
}

/** A short task title derived from the first prompt. */
export function titleFromPrompt(prompt: string): string {
  const clean = prompt.trim().replace(/\s+/g, " ");
  return clean.length > 48 ? clean.slice(0, 48) + "…" : clean;
}

// --- Sidebar grouping (as in web Wello: pinned + friendly date bands) ---------

export interface TaskGroup {
  key: "pinned" | "today" | "yesterday" | "week" | "earlier";
  label: string;
  tasks: TaskItem[];
}

/** When the chat was last touched by the user; snapshots from older builds fall back
 *  to the last run's start (and, failing that, to the "earlier" band). */
export function taskActivityMs(task: TaskItem): number {
  const stamp = task.updatedAt ?? task.agent.startedAt;
  const ms = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Buckets tasks for the sidebar: the pinned block first (manual order preserved —
 * it's drag-sortable), then the rest newest-first in date bands.
 */
export function groupTasks(tasks: TaskItem[], now: number = Date.now()): TaskGroup[] {
  const pinned = tasks.filter((t) => t.pinned);
  const rest = tasks
    .filter((t) => !t.pinned)
    .slice()
    .sort((a, b) => taskActivityMs(b) - taskActivityMs(a));

  const d = new Date(now);
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayMs = 86_400_000;
  const bands: { key: TaskGroup["key"]; label: string; min: number; tasks: TaskItem[] }[] = [
    { key: "today", label: "Сегодня", min: startOfToday, tasks: [] },
    { key: "yesterday", label: "Вчера", min: startOfToday - dayMs, tasks: [] },
    { key: "week", label: "Предыдущие 7 дней", min: startOfToday - 7 * dayMs, tasks: [] },
    { key: "earlier", label: "Ранее", min: -Infinity, tasks: [] },
  ];
  for (const t of rest) {
    // The trailing band has min -Infinity, so find() always matches.
    bands.find((b) => taskActivityMs(t) >= b.min)!.tasks.push(t);
  }

  const groups: TaskGroup[] = [];
  if (pinned.length > 0) groups.push({ key: "pinned", label: "Закреплённые", tasks: pinned });
  for (const b of bands) {
    if (b.tasks.length > 0) groups.push({ key: b.key, label: b.label, tasks: b.tasks });
  }
  return groups;
}
