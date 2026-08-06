/**
 * Line comments on the review diff — the tightest feedback loop there is:
 * point at the exact line, say what to change, send the whole batch to the
 * agent as one follow-up turn.
 *
 * Pure data + prompt assembly (unit-tested); Changes.tsx owns the UI.
 */

export interface DiffComment {
  id: string;
  /** Workspace-relative file the comment belongs to. */
  file: string;
  /** Gutter number of the anchored row (new side; old side for deletions). */
  line: number | null;
  /** What the row was: an addition, a deletion or unchanged context. */
  kind: "add" | "del" | "ctx";
  /** The exact code line the comment anchors to — survives line drift. */
  code: string;
  /** The user's remark. */
  text: string;
}

/** Where a deleted row's number points, for honest wording in the prompt. */
function lineLabel(c: DiffComment): string {
  if (c.line == null) return "";
  return c.kind === "del" ? `строка ${c.line} (до правки)` : `строка ${c.line}`;
}

/**
 * The follow-up turn the batch becomes. One numbered list, grouped by file —
 * the model gets the exact line text as an anchor (numbers drift, code much
 * less), plus a closing instruction to report per item.
 */
export function buildReviewPrompt(comments: DiffComment[]): string {
  if (comments.length === 0) return "";
  const byFile = new Map<string, DiffComment[]>();
  for (const c of comments) {
    const list = byFile.get(c.file) ?? [];
    list.push(c);
    byFile.set(c.file, list);
  }
  const parts: string[] = [
    "Замечания по твоим изменениям (ревью диффа). Внеси правки по каждому пункту:",
    "",
  ];
  let n = 0;
  for (const [file, list] of byFile) {
    for (const c of list) {
      n += 1;
      const where = lineLabel(c);
      parts.push(`${n}. \`${file}\`${where ? `, ${where}` : ""}:`);
      if (c.code.trim()) parts.push(`   > ${c.code.trim().slice(0, 200)}`);
      parts.push(`   Замечание: ${c.text.trim()}`);
      parts.push("");
    }
  }
  parts.push("Когда закончишь, кратко перечисли по пунктам, что именно изменил.");
  return parts.join("\n");
}
