import type { AgentEvent } from "@wello-code/contracts";

/**
 * Coalesce the answer's stream on its way to the window.
 *
 * The engine emits one event per token chunk — dozens a second. Each one was a
 * separate IPC message, a separate reducer pass and a separate React render, and
 * each render re-parsed the markdown of the answer as it grew: the longer the
 * reply, the more expensive every remaining chunk of it. That is the shape of
 * "чем дольше отвечает, тем сильнее тормозит".
 *
 * Consecutive chunks of the SAME message are merged into one event and sent at
 * most every FLUSH_MS. Everything else — a tool starting, a permission card, the
 * run finishing — flushes what is buffered and goes through immediately, so
 * order is exactly what the engine produced and nothing that needs a reaction
 * waits behind text.
 */

/** ~20 updates a second: below what reads as continuous typing, far below what
 *  a chunk-per-render costs. */
const FLUSH_MS = 50;

type Delta = Extract<AgentEvent, { type: "message.delta" }>;

function isDelta(event: AgentEvent): event is Delta {
  return event.type === "message.delta";
}

/** Wrap a send function so streamed text arrives in batches instead of chunks. */
export function batchAgentEvents(send: (event: AgentEvent) => void): (event: AgentEvent) => void {
  let held: Delta | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const event = held;
    held = null;
    if (event) send(event);
  };

  return (event: AgentEvent) => {
    if (!isDelta(event)) {
      flush();
      send(event);
      return;
    }
    if (held && held.data.messageId === event.data.messageId) {
      held = { ...held, data: { ...held.data, text: held.data.text + event.data.text } };
    } else {
      flush(); // a different message started — its text must not join this one
      held = event;
    }
    if (!timer) {
      timer = setTimeout(flush, FLUSH_MS);
      timer.unref?.();
    }
  };
}
