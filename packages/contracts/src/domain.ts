import { z } from "zod";

/** Agent interaction mode. Ask/Plan are read-only; Build may mutate via approved intents. */
/**
 * Permission mode of a run (mirrors the engine's modes). "ask" and "build" are
 * legacy values kept so persisted tasks from older builds stay valid; the UI now
 * offers manual / acceptEdits / plan / auto / bypass.
 */
export const TaskMode = z.enum(["ask", "plan", "build", "manual", "acceptEdits", "auto", "bypass"]);
export type TaskMode = z.infer<typeof TaskMode>;

/** Lifecycle status of a task/run (mirrors the run state machine in DATA_AND_EVENTS.md). */
export const TaskStatus = z.enum([
  "draft",
  "planning",
  "awaiting_approval",
  "working",
  "awaiting_input",
  "paused",
  "reviewing",
  "completed",
  "failed",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

/** Workspace trust posture. Restricted denies agent writes/commands/network by default. */
export const TrustLevel = z.enum(["restricted", "trusted"]);
export type TrustLevel = z.infer<typeof TrustLevel>;

export const Workspace = z.object({
  id: z.string(),
  /** Canonical, symlink-resolved absolute path. Resolved in privileged code, never trusted from UI. */
  canonicalPath: z.string(),
  displayName: z.string(),
  trust: TrustLevel,
  repositoryId: z.string().optional(),
  lastOpenedAt: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

/** A piece of context attached to a task (never silently sent to a provider in full). */
export const ContextReference = z.object({
  kind: z.enum(["file", "folder", "selection", "diff", "terminal_output", "image"]),
  label: z.string(),
  locator: z.string(),
  range: z.object({ startLine: z.number().int(), endLine: z.number().int() }).optional(),
});
export type ContextReference = z.infer<typeof ContextReference>;

export const Task = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  mode: TaskMode,
  status: TaskStatus,
  activeRunId: z.string().optional(),
  context: z.array(ContextReference),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof Task>;

export const AgentRun = z.object({
  id: z.string(),
  taskId: z.string(),
  worktreeId: z.string().optional(),
  modelProfileId: z.string(),
  state: TaskStatus,
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  checkpointIds: z.array(z.string()),
});
export type AgentRun = z.infer<typeof AgentRun>;

/**
 * Models the Wello upstream serves with their native million-token window.
 *
 * One list, in the one place both halves of the app can read, because two very
 * different pieces of code have to agree on it and neither can tell when the
 * other is wrong. The engine is handed a "[1m]" variant of the model id so its
 * own budgeting uses the real window; the context gauge divides by the same
 * number. While only the engine side knew, the gauge fell back to the engine's
 * reported default of 200K and told people a task was half spent when it had
 * used a tenth — measured on Opus 5, which had just carried a 313K prompt end to
 * end (2026-08-08).
 *
 * ⚠️ Ids are spelled the way the PICKER and the engine spell them (dashes:
 * `claude-opus-4-8`). The server catalog spells the same model with a dot; these
 * are not interchangeable, and matching the wrong side silently drops an entry.
 */
export const CONTEXT_WINDOW_1M = 1_000_000;

export const MODELS_1M_CONTEXT: readonly string[] = [
  "claude-sonnet-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-fable-5",
];

/**
 * The model a request falls back to when nothing else picked one.
 *
 * One constant, because it was five copies of the same literal — the engine's
 * default, chat titles, commit messages, PR text and the handoff summary — and a
 * model withdrawn from the picker kept being sent by all of them. Whatever the
 * picker offers first, this has to name a model we actually serve well.
 */
export const DEFAULT_CODE_MODEL = "claude-opus-5";
