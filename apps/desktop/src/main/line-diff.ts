/**
 * A minimal unified line-diff (LCS) for the git-less review path. Emits exactly the
 * unified format the renderer's parseDiff/HUNK_RE already consume (Changes.tsx), so
 * snapshot diffs render identically to git diffs — with zero new runtime deps.
 */

/** Above this line count on either side, skip LCS (O(n·m)) and show a full replace. */
const MAX_DIFF_LINES = 3000;
const CONTEXT = 3;

/** Logical lines: split on \n, drop a trailing \r (CRLF) and the final empty line. */
function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

type OpType = "eq" | "del" | "add";
interface Op {
  type: OpType;
  line: string;
}

/** Backtrack an LCS DP table into a delete/insert/equal op sequence. */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ type: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ type: "add", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ type: "del", line: a[i++]! });
  while (j < m) ops.push({ type: "add", line: b[j++]! });
  return ops;
}

function fullReplaceOps(a: string[], b: string[]): Op[] {
  return [
    ...a.map((line): Op => ({ type: "del", line })),
    ...b.map((line): Op => ({ type: "add", line })),
  ];
}

/** Group ops into unified hunks with CONTEXT lines of surrounding equal context. */
function formatUnified(ops: Op[], context: number): string {
  type Annotated = Op & { oldN: number; newN: number };
  const ann: Annotated[] = [];
  let o = 1;
  let n = 1;
  for (const op of ops) {
    if (op.type === "eq") ann.push({ ...op, oldN: o++, newN: n++ });
    else if (op.type === "del") ann.push({ ...op, oldN: o++, newN: n });
    else ann.push({ ...op, oldN: o, newN: n++ });
  }
  const changed = ann.reduce<number[]>((acc, x, idx) => (x.type !== "eq" ? [...acc, idx] : acc), []);
  if (changed.length === 0) return "";

  const ranges: Array<[number, number]> = [];
  for (const idx of changed) {
    const start = Math.max(0, idx - context);
    const end = Math.min(ann.length - 1, idx + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  const out: string[] = [];
  for (const [start, end] of ranges) {
    const slice = ann.slice(start, end + 1);
    const oldStart = slice.find((x) => x.type !== "add")?.oldN ?? slice[0]?.oldN ?? 1;
    const newStart = slice.find((x) => x.type !== "del")?.newN ?? slice[0]?.newN ?? 1;
    const oldCount = slice.filter((x) => x.type !== "add").length;
    const newCount = slice.filter((x) => x.type !== "del").length;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const x of slice) {
      out.push((x.type === "eq" ? " " : x.type === "del" ? "-" : "+") + x.line);
    }
  }
  return out.join("\n");
}

/** Unified diff of `base` → `current` plus added/removed line counts. */
export function lineDiff(base: string, current: string): {
  diff: string;
  additions: number;
  deletions: number;
} {
  const a = splitLines(base);
  const b = splitLines(current);
  const ops =
    a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES ? fullReplaceOps(a, b) : lcsOps(a, b);
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "add") additions++;
    else if (op.type === "del") deletions++;
  }
  if (additions === 0 && deletions === 0) return { diff: "", additions: 0, deletions: 0 };
  return { diff: formatUnified(ops, CONTEXT), additions, deletions };
}
