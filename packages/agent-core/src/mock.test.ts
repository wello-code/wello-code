import { describe, expect, it } from "vitest";
import type { AgentEvent, TaskMode } from "@wello-code/contracts";
import { MockAgentProvider, deterministicClock, deterministicIds } from "./mock";
import type { AgentRequest } from "./provider";

function request(mode: TaskMode): AgentRequest {
  return {
    taskId: "t1",
    runId: "r1",
    workspaceId: "w1",
    mode,
    prompt: "do the thing",
    context: [],
    modelProfileId: "m1",
  };
}

async function collect(mode: TaskMode, signal?: AbortSignal): Promise<AgentEvent[]> {
  const provider = new MockAgentProvider({ clock: deterministicClock(), ids: deterministicIds() });
  const ac = new AbortController();
  const events: AgentEvent[] = [];
  for await (const e of provider.stream(request(mode), signal ?? ac.signal)) {
    events.push(e);
  }
  return events;
}

const types = (events: AgentEvent[]): string[] => events.map((e) => e.type);

describe("MockAgentProvider", () => {
  it("build mode emits a full plan → tool → permission → changes → completion flow", async () => {
    const events = await collect("build");
    const t = types(events);
    expect(t[0]).toBe("run.status_changed");
    expect(t).toContain("run.plan_ready");
    expect(t).toContain("permission.requested");
    expect(t).toContain("changes.ready");
    expect(t.at(-1)).toBe("run.completed");
  });

  it("ask/plan modes never emit a permission or a change (read-only)", async () => {
    for (const mode of ["ask", "plan"] as const) {
      const t = types(await collect(mode));
      expect(t).not.toContain("permission.requested");
      expect(t).not.toContain("changes.ready");
      expect(t.at(-1)).toBe("run.completed");
    }
  });

  it("is deterministic across runs with fresh deterministic clock/ids", async () => {
    const a = await collect("build");
    const b = await collect("build");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("a pre-aborted signal yields a single cancelled status and stops", async () => {
    const ac = new AbortController();
    ac.abort();
    const events = await collect("build", ac.signal);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("run.status_changed");
    expect(events[0]!.data).toMatchObject({ to: "cancelled" });
  });
});
