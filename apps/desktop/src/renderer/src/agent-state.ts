import type {
  AgentEvent,
  PermissionRequest,
  PlanStep,
  PlanTodo,
  QuestionRequest,
} from "@wello-code/contracts";
import type { IconName } from "./Icon";

/** A non-image attachment as shown on a sent user message (chips, not prompt text). */
export interface UserAttachment {
  kind: "file" | "folder" | "paste";
  label: string;
}

export type TimelineItem =
  | {
      kind: "user";
      id: string;
      /** What the user typed (bubble text). */
      text: string;
      images?: string[];
      attachments?: UserAttachment[];
      /** The full model-facing prompt when it differs from `text` — retries resend it. */
      fullText?: string;
      /** The run id of this turn — the label of its pre-run checkpoint (rewind). */
      runId?: string;
    }
  | {
      kind: "message";
      id: string;
      text: string;
      done: boolean;
      /** Engine message uuid — the fork anchor for "edit an earlier turn". */
      sdkUuid?: string;
    }
  | { kind: "tool"; id: string; summary: string; status: string; icon: IconName; subagent: boolean }
  | { kind: "plan"; id: string; steps: PlanStep[]; summary: string }
  | { kind: "note"; id: string; text: string; tone: "info" | "success" | "danger" | "cancelled" };

/** One spawned subagent (a Task tool call) with its own transcript. */
export interface SubagentInfo {
  id: string;
  title: string;
  status: "running" | "done" | "failed";
  transcript: { entry: "text" | "tool"; text: string }[];
  startedAt: string;
  finishedAt: string | null;
}

export interface AgentState {
  items: TimelineItem[];
  running: boolean;
  pending: PermissionRequest | null;
  question: QuestionRequest | null;
  /** The agent's github_connect card (blocks the run until answered). */
  githubConnect: { id: string; runId: string } | null;
  subagents: SubagentInfo[];
  startedAt: string | null;
  elapsedMs: number | null;
  /** Context gauge: tokens occupied after the latest turn / the model's window. */
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  /** The last run's failure, so the UI can offer a top-up CTA and skip a futile
   *  retry for non-retryable errors (out of balance). Cleared on each new turn. */
  lastFailure: { code: string; retryable: boolean } | null;
  /** The agent's live todo list (TodoWrite snapshots) — the plan widget. */
  plan: PlanTodo[] | null;
}

export const initialAgentState: AgentState = {
  items: [],
  running: false,
  pending: null,
  question: null,
  githubConnect: null,
  subagents: [],
  startedAt: null,
  elapsedMs: null,
  contextUsedTokens: null,
  contextWindowTokens: null,
  lastFailure: null,
  plan: null,
};

export interface UserTurnPayload {
  prompt: string;
  images?: string[];
  attachments?: UserAttachment[];
  fullText?: string;
  /** The run id of this turn (checkpoint label for rewind). */
  runId?: string;
}

export type AgentAction =
  | ({ type: "start" } & UserTurnPayload)
  | ({ type: "followup" } & UserTurnPayload)
  | ({ type: "editTurn"; itemId: string } & UserTurnPayload)
  | { type: "cancelLocal" }
  | { type: "resolvePermission" }
  | { type: "resolveQuestion" }
  | { type: "resolveGithubConnect" }
  | { type: "event"; event: AgentEvent };

function userTurn(payload: UserTurnPayload): TimelineItem {
  return {
    kind: "user",
    id: crypto.randomUUID(),
    text: payload.prompt,
    ...(payload.images && payload.images.length > 0 ? { images: payload.images } : {}),
    ...(payload.attachments && payload.attachments.length > 0
      ? { attachments: payload.attachments }
      : {}),
    ...(payload.fullText && payload.fullText !== payload.prompt
      ? { fullText: payload.fullText }
      : {}),
    ...(payload.runId ? { runId: payload.runId } : {}),
  };
}

export function agentReducer(state: AgentState, action: AgentAction): AgentState {
  if (action.type === "start") {
    return {
      items: [userTurn(action)],
      running: true,
      pending: null,
      question: null,
      githubConnect: null,
      subagents: [],
      startedAt: null,
      elapsedMs: null,
      contextUsedTokens: null,
      contextWindowTokens: null,
      lastFailure: null,
      plan: null,
    };
  }
  if (action.type === "followup") {
    // A new turn in the same conversation: keep history, reset the turn clock.
    return {
      ...state,
      items: [...state.items, userTurn(action)],
      running: true,
      pending: null,
      question: null,
      githubConnect: null,
      startedAt: null,
      elapsedMs: null,
      lastFailure: null,
    };
  }
  if (action.type === "editTurn") {
    // Edit an earlier turn: everything from that user message on is replaced by
    // the corrected message (the engine forks at the matching point, so the
    // truncated timeline and the model's context agree). The plan belonged to
    // the discarded branch.
    const idx = state.items.findIndex((i) => i.kind === "user" && i.id === action.itemId);
    const kept = idx === -1 ? state.items : state.items.slice(0, idx);
    return {
      ...state,
      items: [...kept, userTurn(action)],
      running: true,
      pending: null,
      question: null,
      githubConnect: null,
      startedAt: null,
      elapsedMs: null,
      lastFailure: null,
      plan: null,
    };
  }
  if (action.type === "cancelLocal") {
    // The user hit Stop: the UI settles INSTANTLY; the engine's own cancelled
    // event arrives later and is muted upstream (tasks-state) as a duplicate.
    const now = new Date().toISOString();
    return {
      ...state,
      running: false,
      pending: null,
      question: null,
      githubConnect: null,
      subagents: finalizeSubagents(state.subagents, now),
      plan: finalizePlan(state.plan, "pending"),
      elapsedMs: state.startedAt ? Math.max(0, Date.parse(now) - Date.parse(state.startedAt)) : null,
      items: [...state.items, note(crypto.randomUUID(), "Запуск отменён", "cancelled")],
      lastFailure: null,
    };
  }
  if (action.type === "resolvePermission") return { ...state, pending: null };
  if (action.type === "resolveQuestion") return { ...state, question: null };
  if (action.type === "resolveGithubConnect") return { ...state, githubConnect: null };
  return applyEvent(state, action.event);
}

function iconForIntent(kind: string): IconName {
  switch (kind) {
    case "read_file":
      return "file";
    case "search":
      return "search";
    case "run_command":
      return "terminal";
    case "apply_patch":
      return "edit";
    case "network_request":
      return "globe";
    default:
      return "dot";
  }
}

/** Present-tense RU label for a running tool's icon (shimmer status line). */
export function toolActionLabel(icon: IconName): string {
  switch (icon) {
    case "file":
      return "Читаю файлы…";
    case "edit":
      return "Пишу код…";
    case "search":
      return "Ищу в проекте…";
    case "terminal":
      return "Запускаю команду…";
    case "globe":
      return "Обращаюсь к сети…";
    case "subagent":
      return "Работают агенты…";
    default:
      return "Работаю…";
  }
}

/**
 * What the agent is doing RIGHT NOW, for the shimmer status line (null when idle).
 * A running tool names itself; a streaming answer is «Печатаю ответ…»; otherwise a
 * silent model turn is «Думает…» — the case that made Fable look hung.
 */
export function describeCurrentAction(items: TimelineItem[], running: boolean): string | null {
  if (!running) return null;
  const last = items[items.length - 1];
  if (last?.kind === "tool" && last.status === "running") return toolActionLabel(last.icon);
  if (last?.kind === "message" && !last.done && last.text.trim()) return "Печатаю ответ…";
  return "Думает…";
}

function elapsed(startedAt: string | null, event: AgentEvent): number | null {
  return startedAt ? Math.max(0, Date.parse(event.timestamp) - Date.parse(startedAt)) : null;
}

/**
 * A run reached a terminal state: no subagent may stay "running" forever — the
 * engine will not deliver their results anymore (cancel/failure kills them too).
 */
function finalizeSubagents(subagents: SubagentInfo[], timestamp: string): SubagentInfo[] {
  if (!subagents.some((s) => s.status === "running")) return subagents;
  return subagents.map((s) =>
    s.status === "running" ? { ...s, status: "done", finishedAt: timestamp } : s,
  );
}

/**
 * Same truth-keeping for the plan widget: once the run ends, nothing is "in
 * progress" anymore. Models routinely finish the work of the LAST plan item and
 * answer without a final TaskUpdate (seen live: «Pre-flight аудит и пуш» spun
 * forever under a successful push) — a successful run completes those items,
 * while a failure/cancel returns them to pending instead of claiming they ran.
 */
export function finalizePlan(
  plan: PlanTodo[] | null,
  outcome: "completed" | "pending",
): PlanTodo[] | null {
  if (!plan || !plan.some((p) => p.status === "in_progress")) return plan;
  return plan.map((p) => (p.status === "in_progress" ? { ...p, status: outcome } : p));
}

function applyEvent(prev: AgentState, event: AgentEvent): AgentState {
  const state = prev.startedAt ? prev : { ...prev, startedAt: event.timestamp };
  switch (event.type) {
    case "run.status_changed": {
      if (event.data.to === "cancelled") {
        return {
          ...state,
          running: false,
          pending: null,
          question: null,
          githubConnect: null,
          subagents: finalizeSubagents(state.subagents, event.timestamp),
          plan: finalizePlan(state.plan, "pending"),
          elapsedMs: elapsed(state.startedAt, event),
          items: [...state.items, note(event.id, "Запуск отменён", "cancelled")],
          lastFailure: null,
        };
      }
      return state;
    }
    case "run.plan_ready": {
      const item: TimelineItem = {
        kind: "plan",
        id: event.id,
        steps: event.data.steps,
        summary: event.data.summary,
      };
      return { ...state, items: [...state.items, item] };
    }
    case "message.delta": {
      const id = event.data.messageId;
      const idx = state.items.findIndex((i) => i.kind === "message" && i.id === id);
      if (idx === -1) {
        return {
          ...state,
          items: [...state.items, { kind: "message", id, text: event.data.text, done: false }],
        };
      }
      const items = state.items.slice();
      const prevItem = items[idx] as Extract<TimelineItem, { kind: "message" }>;
      items[idx] = { ...prevItem, text: prevItem.text + event.data.text };
      return { ...state, items };
    }
    case "message.completed": {
      const id = event.data.messageId;
      const sdkUuid = event.data.sdkUuid;
      const idx = state.items.findIndex((i) => i.kind === "message" && i.id === id);
      if (idx === -1) {
        return {
          ...state,
          items: [
            ...state.items,
            {
              kind: "message",
              id,
              text: event.data.summary,
              done: true,
              ...(sdkUuid ? { sdkUuid } : {}),
            },
          ],
        };
      }
      const items = state.items.slice();
      const prevItem = items[idx] as Extract<TimelineItem, { kind: "message" }>;
      const text = event.data.summary.length > prevItem.text.length ? event.data.summary : prevItem.text;
      items[idx] = { ...prevItem, text, done: true, ...(sdkUuid ? { sdkUuid } : {}) };
      return { ...state, items };
    }
    case "tool.requested": {
      const subagent = event.data.summary.startsWith("Subagent · ");
      // A Workflow launch reads as an agent fleet, not a shell command; its
      // agents surface in the Subagents panel via workflow.progress snapshots.
      const workflow = event.data.summary.startsWith("Workflow · ");
      const item: TimelineItem = {
        kind: "tool",
        id: event.data.id,
        summary: event.data.summary,
        status: event.data.status,
        subagent,
        icon: subagent || workflow ? "subagent" : iconForIntent(event.data.intent.kind),
      };
      const next = { ...state, items: [...state.items, item] };
      if (subagent) {
        next.subagents = [
          ...state.subagents,
          {
            id: event.data.id,
            title: event.data.summary.replace(/^Subagent · /, ""),
            status: "running",
            transcript: [],
            startedAt: event.timestamp,
            finishedAt: null,
          },
        ];
      }
      return next;
    }
    case "tool.updated": {
      const idx = state.items.findIndex((i) => i.kind === "tool" && i.id === event.data.id);
      let next = state;
      if (idx !== -1) {
        const items = state.items.slice();
        const prevItem = items[idx] as Extract<TimelineItem, { kind: "tool" }>;
        items[idx] = { ...prevItem, status: event.data.status };
        next = { ...next, items };
      }
      if (state.subagents.some((s) => s.id === event.data.id)) {
        next = {
          ...next,
          subagents: next.subagents.map((s) =>
            s.id === event.data.id
              ? {
                  ...s,
                  status: event.data.status === "failed" ? "failed" : "done",
                  finishedAt: event.timestamp,
                }
              : s,
          ),
        };
      }
      // A workflow settled: none of its fleet may stay "running" — the engine
      // sends no further snapshots (covers a mid-flight workflow failure).
      const wfPrefix = `wf:${event.data.id}:`;
      if (next.subagents.some((s) => s.id.startsWith(wfPrefix) && s.status === "running")) {
        next = {
          ...next,
          subagents: next.subagents.map((s) =>
            s.id.startsWith(wfPrefix) && s.status === "running"
              ? {
                  ...s,
                  status: event.data.status === "failed" ? "failed" : "done",
                  finishedAt: event.timestamp,
                }
              : s,
          ),
        };
      }
      return next;
    }
    case "workflow.progress": {
      // Each frame is a FULL roster snapshot: rebuild this workflow's synthetic
      // subagents in place (stable wf-scoped ids keep selection/tints steady).
      const prefix = `wf:${event.data.toolUseId}:`;
      const fresh: SubagentInfo[] = event.data.agents.map((a) => {
        const finished = a.state === "done" || a.state === "error";
        const transcript: SubagentInfo["transcript"] = [];
        if (a.promptPreview) transcript.push({ entry: "text", text: a.promptPreview });
        if (a.resultPreview) transcript.push({ entry: "text", text: a.resultPreview });
        return {
          id: `${prefix}${a.id}`,
          title: a.phase && a.label ? `${a.phase} · ${a.label}` : (a.label ?? a.phase ?? `агент ${a.id}`),
          status: a.state === "error" ? "failed" : finished ? "done" : "running",
          transcript,
          startedAt: a.startedAt ? new Date(a.startedAt).toISOString() : event.timestamp,
          finishedAt: finished && a.updatedAt ? new Date(a.updatedAt).toISOString() : null,
        };
      });
      return {
        ...state,
        subagents: [...state.subagents.filter((s) => !s.id.startsWith(prefix)), ...fresh],
      };
    }
    case "subagent.message": {
      const { toolUseId, text, entry } = event.data;
      if (!state.subagents.some((s) => s.id === toolUseId)) return state;
      return {
        ...state,
        subagents: state.subagents.map((s) =>
          s.id === toolUseId
            ? {
                ...s,
                // A growing transcript proves the agent is alive — heal a premature
                // "done" (e.g. a settle signal the engine sent out of order).
                status: s.status === "failed" ? s.status : "running",
                finishedAt: s.status === "failed" ? s.finishedAt : null,
                transcript: [...s.transcript, { entry, text }],
              }
            : s,
        ),
      };
    }
    case "permission.requested":
      return { ...state, pending: event.data };
    case "question.requested":
      return { ...state, question: event.data };
    case "github.connect_requested":
      return { ...state, githubConnect: event.data };
    case "plan.updated":
      // Every frame carries the FULL list — replace, never merge.
      return { ...state, plan: event.data.items };
    case "run.context":
      return {
        ...state,
        contextUsedTokens: event.data.usedTokens ?? state.contextUsedTokens ?? null,
        contextWindowTokens: event.data.windowTokens ?? state.contextWindowTokens ?? null,
      };
    case "changes.ready":
      // Surfaced in the Changes review panel; no timeline note needed.
      return state;
    case "run.completed":
      // The final assistant message is the answer — don't duplicate it as a note.
      return {
        ...state,
        running: false,
        pending: null,
        question: null,
        githubConnect: null,
        subagents: finalizeSubagents(state.subagents, event.timestamp),
        plan: finalizePlan(state.plan, "completed"),
        elapsedMs: elapsed(state.startedAt, event),
        lastFailure: null,
      };
    case "run.failed":
      return {
        ...state,
        running: false,
        pending: null,
        question: null,
        githubConnect: null,
        subagents: finalizeSubagents(state.subagents, event.timestamp),
        plan: finalizePlan(state.plan, "pending"),
        elapsedMs: elapsed(state.startedAt, event),
        items: [...state.items, note(event.id, event.data.message, "danger")],
        lastFailure: { code: event.data.code, retryable: event.data.retryable },
      };
    default:
      return state;
  }
}

function note(id: string, text: string, tone: "info" | "success" | "danger" | "cancelled"): TimelineItem {
  return { kind: "note", id: `note-${id}`, text, tone };
}
