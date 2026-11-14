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
 *
 * A model on a deal carries it after a bar: "available|promo=50@2026-11-15T14:00:00Z"
 * (the discount in percent and when it ends). It rides inside the same word so the
 * bridge between the processes keeps its shape; the renderer takes it off before
 * reading the rest (modelPromo in models.ts).
 */
export function modelStatusFromBody(body: unknown): Record<string, string> | null {
  const models = (body as { models?: unknown } | null)?.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) return null;
  const out: Record<string, string> = {};
  for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as { availability?: unknown; hidden?: unknown; promo?: unknown };
    const answers = typeof e.availability === "string" ? e.availability : null;
    let word: string | null = null;
    if (e.hidden === true) word = answers ? `hidden:${answers}` : "hidden";
    else if (answers) word = answers;
    if (word === null) continue;
    const promo = promoOf(e.promo);
    out[id] = promo ? `${word}|promo=${promo.pct}@${promo.endsAt}` : word;
  }
  return out;
}

/** A deal as the status states it, or null when there is none or it is malformed. */
function promoOf(raw: unknown): { pct: number; endsAt: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as { pct?: unknown; endsAt?: unknown };
  const pct = typeof p.pct === "number" ? p.pct : Number.NaN;
  if (!Number.isInteger(pct) || pct < 1 || pct > 90) return null;
  if (typeof p.endsAt !== "string" || !Number.isFinite(Date.parse(p.endsAt))) return null;
  return { pct, endsAt: new Date(p.endsAt).toISOString() };
}
