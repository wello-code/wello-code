/**
 * The model picker and what each model's context window actually is.
 *
 * Lives apart from App.tsx so both halves can be tested: the list is what a
 * person chooses from, and the window is what the context ring divides by — a
 * wrong number there tells someone they have room when they do not.
 */

export interface PickerModel {
  id: string;
  label: string;
  hint: string;
}

/**
 * Haiku 4.5 is not in the Wello catalog; a stored selection of it falls back to
 * the first entry via initialModel()'s validation.
 *
 * `gpt-5.6-luna` is deliberately absent too: it errors on every request, and a
 * picker entry that always fails is worse than no entry.
 */
export const MODELS: PickerModel[] = [
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Баланс скорости и качества" },
  { id: "claude-opus-5", label: "Opus 5", hint: "Новейший Opus, максимум качества" },
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "Сложные задачи, максимум качества" },
  { id: "claude-fable-5", label: "Fable 5", hint: "Флагман с размышлениями" },
  { id: "gpt-5.6-terra", label: "GPT Terra", hint: "Дешевле Claude, с размышлениями" },
  { id: "gpt-5.6-sol", label: "GPT Sol", hint: "Самая мощная в линейке GPT" },
];

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
 */
const KNOWN_CONTEXT_WINDOW: Record<string, number> = {
  "gpt-5.6-luna": 400_000,
  "gpt-5.6-terra": 400_000,
  "gpt-5.6-sol": 400_000,
};

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
