/**
 * @-mention support for the composer (Claude Code style): detect an `@query`
 * being typed and rank workspace files against it. Pure + unit-tested; the React
 * layer owns the menu, keyboard nav and insertion.
 */

/** An in-progress @-mention: where the `@` is and what's typed after it. */
export interface MentionQuery {
  /** Index of the `@` in the text. */
  start: number;
  /** The text between `@` and the caret (may be empty right after typing `@`). */
  query: string;
}

/**
 * Detects an active @-mention immediately before the caret. The `@` must start
 * the line or follow whitespace (so an email address never triggers it), and the
 * query runs up to the caret with no spaces. Returns null when there's no mention.
 */
export function detectMention(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, Math.max(0, caret));
  const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const query = m[1] ?? "";
  return { start: caret - query.length - 1, query };
}

/** Last path segment (the file name), for name-first scoring. */
function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** True if `q` appears in `s` as a subsequence (fuzzy: chars in order, gaps ok). */
function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++;
  }
  return i === q.length;
}

/**
 * Score a path against a lowercased query. Higher is better; null = no match.
 * Name matches beat path matches; prefix beats contains beats fuzzy.
 */
function score(path: string, q: string): number | null {
  const p = path.toLowerCase();
  const base = baseName(p);
  if (base === q) return 1000;
  if (base.startsWith(q)) return 900 - base.length;
  const bi = base.indexOf(q);
  if (bi >= 0) return 700 - bi;
  const pi = p.indexOf(q);
  if (pi >= 0) return 500 - pi;
  if (isSubsequence(q, base)) return 300;
  if (isSubsequence(q, p)) return 100 - (p.length - q.length) * 0.01;
  return null;
}

/**
 * Ranks workspace files for the current @-query, best first, capped at `limit`.
 * An empty query returns the first `limit` files (shortest paths first — the
 * top-level, most-likely-wanted ones).
 */
export function rankFileMentions(files: string[], query: string, limit = 12): string[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...files].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
  }
  const scored: { path: string; s: number }[] = [];
  for (const f of files) {
    const s = score(f, q);
    if (s != null) scored.push({ path: f, s });
  }
  scored.sort((a, b) => b.s - a.s || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((x) => x.path);
}
