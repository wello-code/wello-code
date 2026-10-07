/**
 * The picker's view of the service's public status: one word per model.
 *
 * Kept apart from the client that fetches it so the reading can be tested without
 * a window. The words are the status's own ("available", "degraded",
 * "unavailable"), and a model the service does not offer carries a "hidden:"
 * prefix in front of that word ("hidden:available"), or is plain "hidden" when
 * the status says nothing else about it.
 *
 * Two facts, kept apart on purpose: whether a model is OFFERED decides if it is
 * in the picker, whether it ANSWERS decides if it is marked as down. A model
 * taken off the list while it still works is not an outage, and one that was
 * never switched on is not a model to offer (see listedModels and
 * modelAvailability in the renderer).
 */
export function modelStatusFromBody(body: unknown): Record<string, string> | null {
  const models = (body as { models?: unknown } | null)?.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return null;
  const out: Record<string, string> = {};
  for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { availability?: unknown; hidden?: unknown };
    const answers = typeof e.availability === "string" ? e.availability : null;
    if (e.hidden === true) out[id] = answers ? `hidden:${answers}` : "hidden";
    else if (answers) out[id] = answers;
  }
  return out;
}
