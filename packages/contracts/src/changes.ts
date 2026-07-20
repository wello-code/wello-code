import { z } from "zod";

export const ChangedFileKind = z.enum(["added", "modified", "deleted", "renamed", "conflicted"]);
export type ChangedFileKind = z.infer<typeof ChangedFileKind>;

export const ChangedFileReview = z.enum([
  "pending",
  "accepted",
  "rejected",
  "partially_accepted",
]);
export type ChangedFileReview = z.infer<typeof ChangedFileReview>;

export const ChangedFile = z.object({
  path: z.string(),
  kind: ChangedFileKind,
  additions: z.number().int(),
  deletions: z.number().int(),
  review: ChangedFileReview,
  /** Which tool calls produced this file's changes (traceability in review). */
  sourceToolCallIds: z.array(z.string()),
});
export type ChangedFile = z.infer<typeof ChangedFile>;

export const CheckResult = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["pending", "running", "passed", "failed", "skipped"]),
  detail: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResult>;

export const ChangeSetSummary = z.object({
  id: z.string(),
  runId: z.string(),
  baseRevision: z.string(),
  files: z.array(ChangedFile),
  checks: z.array(CheckResult),
  state: z.enum([
    "draft",
    "ready_for_review",
    "partially_applied",
    "applied",
    "reverted",
    "conflicted",
  ]),
});
export type ChangeSetSummary = z.infer<typeof ChangeSetSummary>;
