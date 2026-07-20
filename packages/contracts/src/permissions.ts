import { z } from "zod";
import { RiskLevel } from "./tools";

export const PermissionCapability = z.enum([
  "read",
  "write",
  "command",
  "git",
  "network",
  "external_url",
  "delete",
]);
export type PermissionCapability = z.infer<typeof PermissionCapability>;

/**
 * How wide/long an approval extends. Critical requests never offer a persistent
 * (task/workspace) grant — enforced by the policy engine, not just the UI.
 */
export const PermissionDecision = z.enum([
  "allow_once",
  "allow_for_task",
  "allow_for_workspace",
  "deny",
]);
export type PermissionDecision = z.infer<typeof PermissionDecision>;

export const PermissionScope = z.object({
  workspaceId: z.string(),
  paths: z.array(z.string()).optional(),
  argv: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  host: z.string().optional(),
  gitTarget: z.string().optional(),
});
export type PermissionScope = z.infer<typeof PermissionScope>;

export const PermissionRequest = z.object({
  id: z.string(),
  runId: z.string(),
  intentId: z.string(),
  capability: PermissionCapability,
  risk: RiskLevel,
  /** Plain-language "why" the agent needs this. */
  reason: z.string(),
  /** Concrete consequences shown to the user before they decide. */
  impact: z.array(z.string()),
  scope: PermissionScope,
  /** Which decisions the UI may offer (critical actions omit persistent grants). */
  allowedDecisions: z.array(PermissionDecision),
  expiresAt: z.string().optional(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const PermissionAnswer = z.object({
  requestId: z.string(),
  decision: PermissionDecision,
});
export type PermissionAnswer = z.infer<typeof PermissionAnswer>;

/** The broker's resolution of an intent, emitted to the audit log every time. */
export const PolicyDecision = z.object({
  intentId: z.string(),
  outcome: z.enum(["allow", "deny", "ask"]),
  reason: z.string().optional(),
  ruleId: z.string().optional(),
});
export type PolicyDecision = z.infer<typeof PolicyDecision>;
