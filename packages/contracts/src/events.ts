import { z } from "zod";
import { TaskStatus } from "./domain";
import { ToolCall, ToolCallUpdate } from "./tools";
import { PermissionRequest } from "./permissions";
import { QuestionRequest } from "./questions";
import { ChangeSetSummary } from "./changes";

export const PlanStep = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string().optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

/** One item of the agent's live todo/plan list (the engine's TodoWrite state). */
export const PlanTodo = z.object({
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed"]),
});
export type PlanTodo = z.infer<typeof PlanTodo>;

export const RunFailure = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});
export type RunFailure = z.infer<typeof RunFailure>;

export const RunCompletion = z.object({
  summary: z.string(),
  changeSetId: z.string().optional(),
});
export type RunCompletion = z.infer<typeof RunCompletion>;

export const Checkpoint = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.string(),
});
export type Checkpoint = z.infer<typeof Checkpoint>;

/**
 * Wraps every agent event with identity, ordering and correlation metadata. Events
 * are append-only facts (never chain-of-thought); UI reducers derive state from them
 * but must not discard the underlying log.
 */
function envelope<TType extends string, TSchema extends z.ZodTypeAny>(
  type: TType,
  data: TSchema,
) {
  return z.object({
    id: z.string(),
    schemaVersion: z.literal(1),
    type: z.literal(type),
    timestamp: z.string(),
    correlationId: z.string(),
    taskId: z.string().optional(),
    runId: z.string().optional(),
    data,
  });
}

export const AgentEvent = z.union([
  envelope(
    "run.status_changed",
    z.object({ from: TaskStatus, to: TaskStatus, reason: z.string().optional() }),
  ),
  /** The engine assigned/loaded a conversation session — needed to resume follow-ups. */
  envelope("run.session_started", z.object({ sessionId: z.string() })),
  envelope("run.plan_ready", z.object({ steps: z.array(PlanStep), summary: z.string() })),
  /**
   * The agent's live todo list (every TodoWrite call carries the FULL list) —
   * consumers replace, not merge. Powers the plan widget above the composer.
   */
  envelope("plan.updated", z.object({ items: z.array(PlanTodo) })),
  envelope("message.delta", z.object({ messageId: z.string(), text: z.string() })),
  envelope(
    "message.completed",
    z.object({
      messageId: z.string(),
      summary: z.string(),
      /** The engine's SDKAssistantMessage.uuid — the resume/fork anchor for
       *  "edit this turn" (resumeSessionAt points at it). */
      sdkUuid: z.string().optional(),
    }),
  ),
  envelope("tool.requested", ToolCall),
  envelope("tool.updated", ToolCallUpdate),
  /** A subagent's transcript entry, keyed by its parent Task tool_use id. */
  envelope(
    "subagent.message",
    z.object({
      toolUseId: z.string(),
      text: z.string(),
      entry: z.enum(["text", "tool"]),
    }),
  ),
  /**
   * A live snapshot of a Workflow run (the engine's multi-agent orchestration
   * tool, keyed by its tool_use id). Each frame carries the FULL agent roster —
   * consumers replace, not merge. States are engine-defined strings
   * ("queued"/"start"/"done"/"error"); unknown values must degrade gracefully.
   */
  envelope(
    "workflow.progress",
    z.object({
      toolUseId: z.string(),
      summary: z.string().optional(),
      agents: z.array(
        z.object({
          id: z.string(),
          label: z.string().optional(),
          phase: z.string().optional(),
          model: z.string().optional(),
          state: z.string(),
          promptPreview: z.string().optional(),
          resultPreview: z.string().optional(),
          tokens: z.number().optional(),
          /** Engine epoch-ms timestamps (start / last progress). */
          startedAt: z.number().optional(),
          updatedAt: z.number().optional(),
        }),
      ),
    }),
  ),
  envelope("permission.requested", PermissionRequest),
  envelope("question.requested", QuestionRequest),
  /**
   * The agent's github_connect tool wants GitHub connected: the chat renders a
   * one-click connect card and answers via respondGithubConnect — the tool call
   * blocks until then (or until the run ends, which answers "declined").
   */
  envelope("github.connect_requested", z.object({ id: z.string(), runId: z.string() })),
  /**
   * Conversation-context gauge: how full the model's window is after the latest
   * turn. Both fields are optional deltas — used tokens come from assistant-message
   * usage, the window size arrives later with the run result; the reducer merges.
   */
  envelope(
    "run.context",
    z.object({
      usedTokens: z.number().optional(),
      windowTokens: z.number().optional(),
    }),
  ),
  envelope("changes.ready", ChangeSetSummary),
  envelope("checkpoint.created", Checkpoint),
  envelope("run.failed", RunFailure),
  envelope("run.completed", RunCompletion),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** The event `type` string literals, for exhaustive switch handling in reducers. */
export type AgentEventType = AgentEvent["type"];

/** Validate an untrusted payload as an AgentEvent (throws on mismatch). */
export function parseAgentEvent(input: unknown): AgentEvent {
  return AgentEvent.parse(input);
}
