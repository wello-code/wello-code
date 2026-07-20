import {
  parseAgentEvent,
  type AgentEvent,
  type ChangeSetSummary,
  type PlanStep,
  type ToolCall,
} from "@wello-code/contracts";
import type { AgentProvider, AgentRequest, ModelDescriptor, ModelProfile } from "./provider";

/** Injectable clock so mock output is byte-stable in snapshot tests. */
export interface Clock {
  now(): string;
}
/** Injectable id source so mock output is byte-stable in snapshot tests. */
export interface IdFactory {
  next(prefix: string): string;
}

/** Deterministic clock: fixed epoch, advances a fixed step per call (no wall-clock). */
export function deterministicClock(startMs = 1_700_000_000_000, stepMs = 1000): Clock {
  let t = startMs;
  return {
    now() {
      const iso = new Date(t).toISOString();
      t += stepMs;
      return iso;
    },
  };
}

/** Deterministic ids: `${prefix}-1`, `${prefix}-2`, … per prefix. */
export function deterministicIds(): IdFactory {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}-${n}`;
    },
  };
}

export interface MockOptions {
  clock?: Clock;
  ids?: IdFactory;
  /** Delay between events (ms). 0 for tests; a small value gives a lifelike UI stream. */
  delayMs?: number;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Deterministic, network-free AgentProvider. Produces a realistic sequence of
 * plan/message/tool/permission/change/completion events so the entire UX and e2e
 * suite run without a key, network, or any real local command. The emitted events
 * are validated against the contract schema, so the mock also guards the contract.
 */
export class MockAgentProvider implements AgentProvider {
  private readonly opts: MockOptions;

  constructor(opts: MockOptions = {}) {
    this.opts = opts;
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: "wello-mock", label: "Wello Mock", provider: "Mock", contextWindow: 200_000 }];
  }

  async validateProfile(_profile: ModelProfile): Promise<void> {
    /* mock: any profile is valid */
  }

  async *stream(request: AgentRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const clock = this.opts.clock ?? deterministicClock();
    const ids = this.opts.ids ?? deterministicIds();
    const delayMs = this.opts.delayMs ?? 0;
    const correlationId = ids.next("corr");
    const { taskId, runId, mode } = request;

    const ev = (type: string, data: unknown): AgentEvent =>
      parseAgentEvent({
        id: ids.next("evt"),
        schemaVersion: 1,
        type,
        timestamp: clock.now(),
        correlationId,
        taskId,
        runId,
        data,
      });

    const msgId = ids.next("msg");
    const steps: PlanStep[] = [
      { id: ids.next("step"), title: "Read the relevant files" },
      { id: ids.next("step"), title: "Make the change" },
      { id: ids.next("step"), title: "Verify it builds" },
    ];

    const readCall: ToolCall = {
      id: ids.next("tool"),
      runId,
      intent: { kind: "read_file", paths: ["src/index.ts", "package.json"] },
      summary: "Read 2 files",
      status: "running",
      risk: "low",
      idempotencyKey: ids.next("idem"),
    };

    // Build the scenario as thunks so we can check `signal` between steps.
    const script: Array<() => AgentEvent> = [];
    script.push(() => ev("run.status_changed", { from: "draft", to: "planning" }));
    script.push(() => ev("run.plan_ready", { steps, summary: "A 3-step plan." }));

    if (mode === "plan") {
      script.push(() =>
        ev("run.status_changed", { from: "planning", to: "awaiting_approval", reason: "plan ready" }),
      );
      script.push(() => ev("run.completed", { summary: "Plan ready for your approval." }));
    } else {
      script.push(() => ev("run.status_changed", { from: "planning", to: "working" }));
      script.push(() => ev("message.delta", { messageId: msgId, text: "Reading the project…" }));
      script.push(() => ev("tool.requested", readCall));
      script.push(() => ev("tool.updated", { id: readCall.id, status: "succeeded", durationMs: 120 }));

      if (mode === "build") {
        script.push(() =>
          ev("permission.requested", {
            id: ids.next("perm"),
            runId,
            intentId: ids.next("intent"),
            capability: "write",
            risk: "medium",
            reason: "Apply the edit to src/index.ts.",
            impact: ["Writes 1 file inside the workspace."],
            scope: { workspaceId: request.workspaceId, paths: ["src/index.ts"] },
            allowedDecisions: ["allow_once", "allow_for_task", "deny"],
          }),
        );
        const patchCall: ToolCall = {
          id: ids.next("tool"),
          runId,
          intent: {
            kind: "apply_patch",
            patch: "--- a/src/index.ts\n+++ b/src/index.ts\n@@\n-old\n+new\n",
            files: ["src/index.ts"],
          },
          summary: "Edit src/index.ts",
          status: "succeeded",
          risk: "medium",
          idempotencyKey: ids.next("idem"),
          durationMs: 60,
        };
        script.push(() => ev("tool.requested", patchCall));
        script.push(() => ev("message.completed", { messageId: msgId, summary: "Applied 1 change." }));
        const changeSet: ChangeSetSummary = {
          id: ids.next("cs"),
          runId,
          baseRevision: "HEAD",
          files: [
            {
              path: "src/index.ts",
              kind: "modified",
              additions: 1,
              deletions: 1,
              review: "pending",
              sourceToolCallIds: [patchCall.id],
            },
          ],
          checks: [],
          state: "ready_for_review",
        };
        script.push(() => ev("changes.ready", changeSet));
        script.push(() => ev("run.status_changed", { from: "working", to: "reviewing" }));
        script.push(() => ev("run.completed", { summary: "Change ready for review.", changeSetId: changeSet.id }));
      } else {
        // ask: read-only, answer, done.
        script.push(() =>
          ev("message.completed", { messageId: msgId, summary: "Here's what I found." }),
        );
        script.push(() => ev("run.completed", { summary: "Answered." }));
      }
    }

    for (const build of script) {
      if (signal.aborted) {
        yield ev("run.status_changed", { from: "working", to: "cancelled", reason: "cancelled by user" });
        return;
      }
      if (delayMs > 0) await sleep(delayMs, signal);
      yield build();
    }
  }
}
