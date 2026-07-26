/**
 * What the conversation's context COSTS, and when to say so.
 *
 * The agent re-sends the whole conversation on every turn. That is normal — and
 * invisible, because it lands in the prompt cache rather than in anything the
 * user typed. The cost is not invisible: in a long session the re-read context
 * grows until it dwarfs everything the user actually writes, and the per-turn
 * spend climbs by an order of magnitude while the number of turns stays flat.
 * Nothing in the UI ever said so: the only nudge fired at 90% of the window,
 * which on a 1M-context model means 900K tokens — long past the point where
 * every turn had become expensive.
 *
 * So the nudge is keyed on COST, not on how full the window looks:
 *   • WARN  — the context alone now costs more per turn than a fresh chat's
 *             whole exchange usually does;
 *   • URGE  — it dominates the turn: most of what the plan is being charged for
 *             is re-reading the past.
 *
 * Pure module: thresholds + copy, unit-tested. The React layer decides where to
 * show it and what the button does.
 */

/** Context size (tokens) at which re-reading it starts to be the main cost. */
export const CONTEXT_WARN_TOKENS = 120_000;
/** Context size at which nearly every token paid for is the conversation itself. */
export const CONTEXT_URGE_TOKENS = 300_000;

export type ContextPressure = "ok" | "warn" | "urge";

export interface ContextAdvice {
  level: ContextPressure;
  /** One line for the composer note / gauge warning. */
  message: string;
  /** Label for the action that compacts the conversation. */
  action: string;
}

/** Short "126K" style token count (shared with the gauge). */
export function tokensK(n: number): string {
  if (n < 1000) return String(n);
  return `${Math.round(n / 1000)}K`;
}

/**
 * How much of a plan a single turn now spends just on the conversation, relative
 * to a small (10K-token) exchange. Deliberately reported as "×N дороже", which is
 * what a user can act on — the absolute cent figure is ours, not theirs, and the
 * white-label rule keeps raw cap cents out of the client anyway.
 */
export function turnCostMultiplier(usedTokens: number): number {
  const baseline = 10_000;
  return Math.max(1, Math.round(usedTokens / baseline));
}

export function contextAdvice(usedTokens: number | null): ContextAdvice | null {
  if (usedTokens == null || usedTokens < CONTEXT_WARN_TOKENS) return null;
  const size = tokensK(usedTokens);
  if (usedTokens >= CONTEXT_URGE_TOKENS) {
    return {
      level: "urge",
      message:
        `Диалог вырос до ${size} токенов, и агент перечитывает его на каждом шаге — ` +
        `это примерно в ${turnCostMultiplier(usedTokens)} раз дороже короткого чата. ` +
        `Сожмите контекст: агент продолжит с краткой выжимкой вместо всей переписки.`,
      action: "Сжать контекст",
    };
  }
  return {
    level: "warn",
    message:
      `Контекст диалога — ${size} токенов, и он уходит в каждый запрос. ` +
      `Сжатие сохранит суть и заметно снизит расход лимита.`,
    action: "Сжать контекст",
  };
}
