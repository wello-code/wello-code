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
  /**
   * Which shelf the model sits on. "stable" models answer more steadily at busy
   * hours and draw the allowance faster; everything else is the ordinary shelf.
   */
  shelf?: "stable";
}

/**
 * What a person can pick, and the first entry is the default.
 *
 * Deliberately shorter than the Wello catalog since 2026-08-08, and temporarily
 * so: only the models whose turns re-read a cached context instead of
 * paying for the whole conversation again, which is what decides how fast a
 * month's allowance drains. A stored selection of anything absent here falls
 * back to the first entry via initialModel()'s validation, so someone who had
 * another model chosen simply lands on this one.
 *
 * When the rest come back, they go back in this list.
 */
export const MODELS: PickerModel[] = [
  { id: "claude-opus-5", label: "Opus 5", hint: "Новейший Opus, максимум качества" },
  { id: "gpt-5.6-luna", label: "GPT Luna", hint: "Самая быстрая и дешёвая" },
  { id: "gpt-5.6-terra", label: "GPT Terra", hint: "Дешевле Claude, с размышлениями" },
  { id: "gpt-5.6-sol", label: "GPT Sol", hint: "Самая мощная в линейке GPT" },
  // The strongest option here, and the hint says the price out loud on purpose:
  // a turn on Astra draws about five times the allowance a turn on Terra does.
  // Someone who picks it without knowing that hits their monthly limit in a
  // fifth of the time and reads it as the product cheating them, so the warning
  // belongs in the picker itself rather than in a changelog nobody opens.
  { id: "gpt-6-astra", label: "GPT Astra", hint: "Самая сильная, но расходует лимит впятеро быстрее" },
  // The stable shelf. Last on purpose: the default is the first entry, and nobody
  // should land on a model that draws the allowance several times faster without
  // having chosen it. Each hint says what the choice costs, for the same reason
  // Astra's does; what the shelf is FOR is said once, in its caption. They are
  // shown only while the service offers them (see listedModels), so a build that
  // knows about them is harmless before then.
  {
    id: "claude-opus-5.5-stable",
    label: "Opus 5.5",
    hint: "Расходует лимит в несколько раз быстрее",
    shelf: "stable",
  },
  {
    id: "gpt-6.1-sol-stable",
    label: "GPT-6.1 Sol",
    hint: "Расходует лимит примерно как GPT Sol",
    shelf: "stable",
  },
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
  "gpt-6-astra": 400_000,
  "gpt-6.1-sol-stable": 400_000,
  ...Object.fromEntries(MODELS_1M_CONTEXT.map((id) => [id, CONTEXT_WINDOW_1M])),
};

/**
 * How the status marks a model the service does not offer right now: the word
 * itself, or a prefix in front of how the model answers ("hidden:available").
 */
export const STATUS_HIDDEN = "hidden";

/** Is this model off the service's list? */
function isHidden(said: string | null): boolean {
  return said === STATUS_HIDDEN || (said?.startsWith(`${STATUS_HIDDEN}:`) ?? false);
}

/** How the model answers, with the "offered or not" part taken off; null if unsaid. */
function answering(said: string | null): string | null {
  if (said === null || said === STATUS_HIDDEN) return null;
  return said.startsWith(`${STATUS_HIDDEN}:`) ? said.slice(STATUS_HIDDEN.length + 1) : said;
}

/** What the status says about one model, across the dot/dash id split. */
function statusOf(status: Record<string, string> | null | undefined, id: string): string | null {
  if (!status) return null;
  const norm = (s: string): string => s.toLowerCase().replace(/\./g, "-");
  const want = norm(id);
  for (const [key, value] of Object.entries(status)) {
    if (norm(key) === want) return value;
  }
  return null;
}

/**
 * The models to put in the picker, given the service's public status.
 *
 * Two rules, and they differ on purpose.
 *
 * An ordinary model is listed unless the status says the service does not offer
 * it. Silence is not a reason to hide it: a status hiccup must never empty the
 * list (the same reasoning as modelAvailability below).
 *
 * A stable model is listed only when the status NAMES it and does not hide it.
 * Here silence means "not offered": the shelf is switched on from the service's
 * side, and a build that shipped before that moment — or talks to a service that
 * has not heard of the shelf — must not show two models that answer with an
 * error. Hidden is not the same as down: a model that is down stays in the list
 * with its mark, a hidden one is simply not there.
 *
 * `selected` is the model in use, and it is never taken off the list: whatever
 * the status says, the menu must have a row for what the next message will go
 * to. Otherwise a model withdrawn while someone has it chosen would be named on
 * the button and missing from the menu under it.
 */
export function listedModels(
  status: Record<string, string> | null | undefined,
  selected?: string,
): PickerModel[] {
  return MODELS.filter((m) => {
    if (m.id === selected) return true;
    const said = statusOf(status, m.id);
    if (isHidden(said)) return false;
    return m.shelf === "stable" ? said !== null : true;
  });
}

/**
 * The same list in the two groups the picker draws, stable first. Null when no
 * stable model is listed: then there is nothing to group, and the picker looks
 * the way it always did.
 */
export function pickerShelves(
  models: readonly PickerModel[],
): { stable: PickerModel[]; ordinary: PickerModel[] } | null {
  const stable = models.filter((m) => m.shelf === "stable");
  if (stable.length === 0) return null;
  return { stable, ordinary: models.filter((m) => m.shelf !== "stable") };
}

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
 *
 * Whether the model is OFFERED is a different question and is not answered here:
 * one taken off the list while it still works is not down (see listedModels).
 */
export function modelAvailability(
  status: Record<string, string> | null | undefined,
  id: string,
): boolean | null {
  const answers = answering(statusOf(status, id));
  return answers === null ? null : answers === "available";
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
