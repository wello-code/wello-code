import { z } from "zod";

/** Coarse risk rating that drives permission strictness and UI emphasis. */
export const RiskLevel = z.enum(["low", "medium", "high", "critical"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const GitAction = z.enum([
  "status",
  "diff",
  "stage",
  "unstage",
  "commit",
  "push",
  "merge",
  "rebase",
  "create_worktree",
]);
export type GitAction = z.infer<typeof GitAction>;

/**
 * A structured action the agent wants performed. The model can only PROPOSE a
 * ToolIntent; it never executes. Every intent passes the Permission Broker before
 * an executor in privileged code runs it.
 */
export const ToolIntent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read_file"), paths: z.array(z.string()) }),
  z.object({ kind: z.literal("search"), query: z.string(), rootId: z.string() }),
  z.object({ kind: z.literal("apply_patch"), patch: z.string(), files: z.array(z.string()) }),
  z.object({ kind: z.literal("run_command"), argv: z.array(z.string()), cwd: z.string() }),
  z.object({ kind: z.literal("git_action"), action: GitAction }),
  z.object({
    kind: z.literal("network_request"),
    host: z.string(),
    method: z.enum(["GET", "POST"]),
  }),
]);
export type ToolIntent = z.infer<typeof ToolIntent>;

export const ToolCallStatus = z.enum([
  "proposed",
  "awaiting_permission",
  "queued",
  "running",
  "succeeded",
  "failed",
  /** A failure the model routinely recovers from on its own (read-first, retry) —
   *  shown calmly as «повтор» in amber, not a red «ошибка». */
  "recovered",
  "cancelled",
  "denied",
]);
export type ToolCallStatus = z.infer<typeof ToolCallStatus>;

export const ToolCall = z.object({
  id: z.string(),
  runId: z.string(),
  intent: ToolIntent,
  summary: z.string(),
  status: ToolCallStatus,
  risk: RiskLevel,
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  durationMs: z.number().optional(),
  /** Stable key so a retried/replayed call is not double-executed. */
  idempotencyKey: z.string(),
  /** Locator for the (bounded, redacted) result blob — never inline secrets/output here. */
  resultRef: z.string().optional(),
});
export type ToolCall = z.infer<typeof ToolCall>;

export const ToolCallUpdate = z.object({
  id: z.string(),
  status: ToolCallStatus,
  durationMs: z.number().optional(),
  resultRef: z.string().optional(),
});
export type ToolCallUpdate = z.infer<typeof ToolCallUpdate>;
