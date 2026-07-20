import { z } from "zod";
import { ContextReference, TaskMode } from "@wello-code/contracts";
import type { AgentEvent } from "@wello-code/contracts";

export const ModelDescriptor = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  contextWindow: z.number().int(),
});
export type ModelDescriptor = z.infer<typeof ModelDescriptor>;

/**
 * A configured way to reach a model. `secretRef` is an OPAQUE locator into the OS
 * keychain — never the credential itself (SECURITY_AND_PRIVACY.md §5). `baseUrl` lets
 * the real provider point the engine at the Wello gateway (api.wello.dev).
 */
export const ModelProfile = z.object({
  id: z.string(),
  modelId: z.string(),
  secretRef: z.string().optional(),
  baseUrl: z.string().optional(),
});
export type ModelProfile = z.infer<typeof ModelProfile>;

export const AgentRequest = z.object({
  taskId: z.string(),
  runId: z.string(),
  workspaceId: z.string(),
  mode: TaskMode,
  prompt: z.string(),
  context: z.array(ContextReference).default([]),
  modelProfileId: z.string(),
});
export type AgentRequest = z.infer<typeof AgentRequest>;

/**
 * The single seam between the app and whatever runs the agent. The UI and services
 * consume typed `AgentEvent`s only — never provider-specific JSON. `MockAgentProvider`
 * implements this for deterministic UI/e2e; `SdkAgentProvider` (Phase 1) wraps the
 * Claude Agent SDK behind the same interface.
 */
export interface AgentProvider {
  /** Stream typed events for one run. Honors `signal` for cancellation. */
  stream(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent>;
  listModels(): Promise<ModelDescriptor[]>;
  /** Throws if the profile can't be used (bad key, unreachable endpoint, unknown model). */
  validateProfile(profile: ModelProfile): Promise<void>;
}
