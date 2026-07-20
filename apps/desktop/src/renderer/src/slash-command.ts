/**
 * Slash-command support for the composer (Claude Code style): detect a `/query`
 * typed at the very start of the input and offer quick actions. Pure detection +
 * ranking; the React layer owns the registry (with run handlers), menu, keyboard
 * nav and execution.
 */

/** An in-progress slash command: the text after the leading `/`. */
export interface SlashQuery {
  query: string;
}

/**
 * Detects a slash command in progress. The whole input up to the caret must be
 * `/word` — a `/` at position 0 followed by one run of non-space chars — so a
 * slash inside normal prose (a path, a date, a fraction) never triggers the menu.
 */
export function detectSlash(text: string, caret: number): SlashQuery | null {
  if (!text.startsWith("/")) return null;
  const before = text.slice(0, Math.max(0, caret));
  const m = /^\/([^\s/]*)$/.exec(before);
  if (!m) return null;
  return { query: m[1] ?? "" };
}

/** The display shape of a slash command (the runnable version extends this in App). */
export interface SlashCommandDef {
  /** Command word without the slash, e.g. "new". */
  name: string;
  /** Shown label, e.g. "/new". */
  label: string;
  /** One-line description. */
  hint: string;
}

/** Filters the registry by the current query: prefix matches first, then contains. */
export function rankSlashCommands<T extends SlashCommandDef>(commands: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const starts = commands.filter((c) => c.name.startsWith(q));
  const rest = commands.filter(
    (c) => !c.name.startsWith(q) && (c.name.includes(q) || c.hint.toLowerCase().includes(q)),
  );
  return [...starts, ...rest];
}
