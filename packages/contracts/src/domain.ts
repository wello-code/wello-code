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
