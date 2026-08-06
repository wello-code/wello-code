import { describe, expect, it } from "vitest";
import { buildReviewPrompt, type DiffComment } from "./diff-comments";

function c(over: Partial<DiffComment>): DiffComment {
  return {
    id: "1",
    file: "src/app.ts",
    line: 42,
    kind: "add",
    code: "const x = 1;",
    text: "переименуй в count",
    ...over,
  };
}

describe("buildReviewPrompt", () => {
  it("numbers items, quotes the anchored line and closes with a report ask", () => {
    const prompt = buildReviewPrompt([
      c({ id: "a" }),
      c({ id: "b", file: "src/other.ts", line: 7, code: "let y;", text: "убери переменную" }),
    ]);
    expect(prompt).toContain("1. `src/app.ts`, строка 42:");
    expect(prompt).toContain("> const x = 1;");
    expect(prompt).toContain("Замечание: переименуй в count");
    expect(prompt).toContain("2. `src/other.ts`, строка 7:");
    expect(prompt).toContain("что именно изменил");
  });

  it("groups items of one file together even when added out of order", () => {
    const prompt = buildReviewPrompt([
      c({ id: "a", file: "a.ts", line: 1 }),
      c({ id: "b", file: "b.ts", line: 2 }),
      c({ id: "c", file: "a.ts", line: 9, text: "и тут" }),
    ]);
    const first = prompt.indexOf("`a.ts`, строка 1");
    const second = prompt.indexOf("`a.ts`, строка 9");
    const other = prompt.indexOf("`b.ts`");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    // Both a.ts items come before b.ts — grouped, not interleaved.
    expect(other).toBeGreaterThan(second);
  });

  it("a deleted row says its number is pre-edit", () => {
    const prompt = buildReviewPrompt([c({ kind: "del", line: 30, text: "верни эту строку" })]);
    expect(prompt).toContain("строка 30 (до правки)");
  });

  it("tolerates a missing line and empty code", () => {
    const prompt = buildReviewPrompt([c({ line: null, code: "", text: "общий комментарий" })]);
    expect(prompt).toContain("1. `src/app.ts`:");
    expect(prompt).not.toContain(">");
  });

  it("empty batch → empty prompt (button never sends it)", () => {
    expect(buildReviewPrompt([])).toBe("");
  });
});
