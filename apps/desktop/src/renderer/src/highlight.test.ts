import { beforeEach, describe, expect, it } from "vitest";
import { clearHighlightCache, highlight, languageForPath, resolveLanguage } from "./highlight";

/**
 * The cache exists because the chat re-highlights every visible code block on
 * every render, and a streaming answer renders dozens of times per second. What
 * has to stay true: the cached answer is the same answer, different inputs never
 * collide, and the cache cannot grow forever.
 */
describe("highlight", () => {
  beforeEach(() => clearHighlightCache());

  it("returns the same HTML on a repeat call", () => {
    const code = "const answer = 42;";
    const first = highlight(code, "javascript");
    const second = highlight(code, "javascript");
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("keys on the language as well as the source", () => {
    const code = "for i in range(3): pass";
    const asPython = highlight(code, "python");
    const asJs = highlight(code, "javascript");
    // Same text, different grammar — a cache keyed on the text alone would have
    // handed the second call the first one's markup.
    expect(asPython).not.toBe(asJs);
  });

  it("is a repeat, not a coincidence: fresh text still highlights", () => {
    expect(highlight("const a = 1;", "javascript")).toContain("hljs-keyword");
    expect(highlight("let b = 2;", "javascript")).toContain("hljs-keyword");
  });

  it("returns null for an unknown language instead of caching a miss", () => {
    expect(highlight("whatever", null)).toBeNull();
    expect(highlight("whatever", "not-a-language")).toBeNull();
  });

  it("survives far more distinct blocks than it can hold", () => {
    // 600 distinct blocks against a 400-entry cache: eviction must not break
    // correctness, only recency.
    for (let i = 0; i < 600; i++) {
      expect(highlight(`const v${i} = ${i};`, "javascript")).toContain("hljs-keyword");
    }
    // The newest entry is still exact.
    expect(highlight("const v599 = 599;", "javascript")).toContain("v599");
  });
});

describe("resolveLanguage / languageForPath", () => {
  it("maps aliases and extensions onto registered grammars", () => {
    expect(resolveLanguage("ts")).toBe("typescript");
    expect(resolveLanguage("YML")).toBe("yaml");
    expect(resolveLanguage("nope")).toBeNull();
    expect(languageForPath("src/main/updater.ts")).toBe("typescript");
    expect(languageForPath("Makefile")).toBeNull();
  });
});
