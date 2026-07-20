/**
 * Type-ahead queue: messages typed while the agent works. Claude Code semantics —
 * the whole stack rides into ONE follow-up turn when the run finishes (not one
 * run per bubble), so spamming five lines costs one run, not five.
 */

export interface QueuedContent<A> {
  shown?: string;
  images?: string[];
  attachments?: A[];
}

export interface QueuedLike<A> {
  fullText: string;
  content: QueuedContent<A>;
}

/** Merge a task's queued stack into a single turn payload (FIFO order). */
export function mergeQueued<A>(
  batch: QueuedLike<A>[],
): { fullText: string; content: QueuedContent<A> } | null {
  if (batch.length === 0) return null;
  const fullText = batch.map((m) => m.fullText).join("\n\n");
  const shown = batch.map((m) => m.content.shown ?? m.fullText).join("\n\n");
  const images = batch.flatMap((m) => m.content.images ?? []);
  const attachments = batch.flatMap((m) => m.content.attachments ?? []);
  return {
    fullText,
    content: {
      ...(shown !== fullText ? { shown } : {}),
      ...(images.length > 0 ? { images } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
}
