/**
 * The model picker and what each model's context window actually is.
 *
 * Lives apart from App.tsx so both halves can be tested: the list is what a
 * person chooses from, and the window is what the context ring divides by — a
 * wrong number there tells someone they have room when they do not.
 */

import { CONTEXT_WINDOW_1M, MODELS_1M_CONTEXT } from "@wello-code/contracts";

export interface PickerModel {
  id: string;
  label: string;
  hint: string;
}

/**
 * What a person can pick, and the first entry is the default.
 *
 * Deliberately shorter than the Wello catalog since 2026-08-08 (owner decision,
 * temporary): only the models whose turns re-read a cached context instead of
 * paying for the whole conversation again, which is what decides how fast a
 * month's allowance drains. A stored selection of anything absent here falls
 * back to the first entry via initialModel()'s validation, so someone who had
 * another model chosen simply lands on this one.
 *
 * When the rest come back, they go back in this list — and the reason the list
 * is short is stated to the person in the picker itself (see MODELS_NOTE).
 */
export const MODELS: PickerModel[] = [
  { id: "claude-opus-5", label: "Opus 5", hint: "Новейший Opus, максимум качества" },
  { id: "gpt-5.6-luna", label: "GPT Luna", hint: "Самая быстрая и дешёвая" },
  { id: "gpt-5.6-terra", label: "GPT Terra", hint: "Дешевле Claude, с размышлениями" },
  { id: "gpt-5.6-sol", label: "GPT Sol", hint: "Самая мощная в линейке GPT" },
];

/**
 * Why the list is short, in the one place someone looks when a model they used
 * yesterday is missing. Says what it means for them rather than what happened on
 * our side: the allowance lasts longer here, and that is true for exactly the
 * reason these models are the ones left.
 */
export const MODELS_NOTE = "Пока оставили модели, на которых лимит расходуется медленнее.";

/** Default when nothing else says otherwise (every catalog Claude model). */
export const FALLBACK_CONTEXT_WINDOW = 200_000;

/**
 * Windows we know better than the engine does.
 *
 * The engine keeps its own table of Anthropic models and reports a window for
 * them; for anything outside that table it reports its DEFAULT, which is not the
 * same thing as knowing. The GPT family holds 400K, so taking the engine's
 * number would show a full ring at half a context.
 *
 * That is why this map wins over the reported value instead of standing behind
 * it: here we are right and the report is a placeholder.
 *
 * The Claude models are here for exactly the same reason, and it took a live run
 * to notice: the engine does not know these ids either, so it answered with its
 * 200K default and the gauge read «37к использовано / 163к свободно» on a model
 * that had just carried a 313K prompt (Opus 5, 2026-08-08). Five times too small
 * is not a cosmetic error — it is the number that decides when someone is told to
 * split a task, and when the run compacts a context that had plenty of room.
 */
const KNOWN_CONTEXT_WINDOW: Record<string, number> = {
  "gpt-5.6-luna": 400_000,
  "gpt-5.6-terra": 400_000,
  "gpt-5.6-sol": 400_000,
  ...Object.fromEntries(MODELS_1M_CONTEXT.map((id) => [id, CONTEXT_WINDOW_1M])),
};

/**
 * Is a picker model currently served, according to the gateway's public status?
 *
 * Id forms differ between the two worlds — the status speaks in catalog ids
 * with dots («claude-opus-4.8»), the picker in dashed ids («claude-opus-4-8») —
 * so both sides are normalized before matching.
 *
 * Three-valued on purpose: `false` only when the status EXPLICITLY says the
 * model is down. No status / unknown id → `null`, and the picker marks
 * nothing — a status hiccup must never read as «все модели лежат».
 */
export function modelAvailability(
  status: Record<string, string> | null | undefined,
  id: string,
): boolean | null {
  if (!status) return null;
  const norm = (s: string): string => s.toLowerCase().replace(/\./g, "-");
  const want = norm(id);
  for (const [key, value] of Object.entries(status)) {
    if (norm(key) === want) return value === "available";
  }
  return null;
}

/**
 * The window to divide the context gauge by.
 *
 * `reported` is what the engine said, if anything. Ours wins where we have an
 * entry (see above), the engine's is trusted everywhere else, and the flat
 * fallback only covers the first turn, before any usage has been reported.
 */
export function contextWindowFor(model: string, reported: number | null): number {
  const known = KNOWN_CONTEXT_WINDOW[model];
  if (known) return known;
  if (reported != null && reported > 0) return reported;
  return FALLBACK_CONTEXT_WINDOW;
}
