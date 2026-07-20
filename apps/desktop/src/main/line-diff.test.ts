import { describe, expect, it } from "vitest";
import { lineDiff } from "./line-diff";

describe("lineDiff", () => {
  it("no change → empty diff, zero counts", () => {
    expect(lineDiff("a\nb\nc\n", "a\nb\nc\n")).toEqual({ diff: "", additions: 0, deletions: 0 });
  });

  it("pure addition at end", () => {
    const r = lineDiff("a\nb\n", "a\nb\nc\n");
    expect(r.additions).toBe(1);
    expect(r.deletions).toBe(0);
    expect(r.diff).toContain("+c");
    expect(r.diff).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@/m);
  });

  it("pure deletion", () => {
    const r = lineDiff("a\nb\nc\n", "a\nc\n");
    expect(r.additions).toBe(0);
    expect(r.deletions).toBe(1);
    expect(r.diff).toContain("-b");
  });

  it("modification counts as one add + one del", () => {
    const r = lineDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(r).toMatchObject({ additions: 1, deletions: 1 });
    expect(r.diff).toContain("-b");
    expect(r.diff).toContain("+B");
  });

  it("added file (empty base) is all additions", () => {
    expect(lineDiff("", "x\ny\n")).toMatchObject({ additions: 2, deletions: 0 });
  });

  it("deleted file (empty current) is all deletions", () => {
    expect(lineDiff("x\ny\n", "")).toMatchObject({ additions: 0, deletions: 2 });
  });

  it("CRLF vs LF is not a spurious change", () => {
    expect(lineDiff("a\r\nb\r\n", "a\nb\n")).toEqual({ diff: "", additions: 0, deletions: 0 });
  });

  it("emits context lines around a change", () => {
    const r = lineDiff("l1\nl2\nl3\nl4\nl5\n", "l1\nl2\nX\nl4\nl5\n");
    expect(r.diff).toContain(" l1");
    expect(r.diff).toContain(" l5");
    expect(r.diff).toContain("+X");
    expect(r.diff).toContain("-l3");
  });
});
