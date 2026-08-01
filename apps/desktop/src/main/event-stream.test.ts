import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@wello-code/contracts";
import { batchAgentEvents } from "./event-stream";

/**
 * The contract that matters: text is merged, everything else is instant, and the
 * order the engine produced is the order the window sees.
 */

let n = 0;
function delta(messageId: string, text: string): AgentEvent {
  return {
    id: `e${n++}`,
    schemaVersion: 1,
    type: "message.delta",
    timestamp: new Date(0).toISOString(),
    correlationId: "c",
    taskId: "t",
    runId: "r",
    data: { messageId, text },
  } as AgentEvent;
}

function toolRequested(): AgentEvent {
  return {
    id: `e${n++}`,
    schemaVersion: 1,
    type: "tool.requested",
    timestamp: new Date(0).toISOString(),
    correlationId: "c",
    taskId: "t",
    runId: "r",
    data: {
      id: "tool-1",
      summary: "Read · app.ts",
      status: "running",
      intent: { kind: "read_file" },
    },
  } as AgentEvent;
}

describe("batchAgentEvents", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("merges chunks of one message into a single event", () => {
    const seen: AgentEvent[] = [];
    const push = batchAgentEvents((e) => seen.push(e));
    push(delta("m1", "Гото"));
    push(delta("m1", "во. "));
    push(delta("m1", "Разобрал."));
    expect(seen).toHaveLength(0); // nothing sent yet — still inside the window
    vi.advanceTimersByTime(60);
    expect(seen).toHaveLength(1);
    expect((seen[0] as { data: { text: string } }).data.text).toBe("Готово. Разобрал.");
  });

  it("never merges across messages", () => {
    const seen: AgentEvent[] = [];
    const push = batchAgentEvents((e) => seen.push(e));
    push(delta("m1", "первый"));
    push(delta("m2", "второй"));
    vi.advanceTimersByTime(60);
    expect(seen.map((e) => (e as { data: { text: string } }).data.text)).toEqual([
      "первый",
      "второй",
    ]);
  });

  it("sends anything that is not text immediately, after the text before it", () => {
    const seen: AgentEvent[] = [];
    const push = batchAgentEvents((e) => seen.push(e));
    push(delta("m1", "сейчас прочитаю"));
    push(toolRequested());
    // No timer advance: a tool card must not wait behind buffered text.
    expect(seen.map((e) => e.type)).toEqual(["message.delta", "tool.requested"]);
  });

  it("keeps streaming after a flush", () => {
    const seen: AgentEvent[] = [];
    const push = batchAgentEvents((e) => seen.push(e));
    push(delta("m1", "раз"));
    vi.advanceTimersByTime(60);
    push(delta("m1", "два"));
    vi.advanceTimersByTime(60);
    expect(seen.map((e) => (e as { data: { text: string } }).data.text)).toEqual(["раз", "два"]);
  });
});
