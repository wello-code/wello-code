import { describe, it, expect } from "vitest";
import { detectMention, rankFileMentions } from "./file-mention";

describe("detectMention", () => {
  it("detects @ at the caret after a space or line start", () => {
    expect(detectMention("open @src", 9)).toEqual({ start: 5, query: "src" });
    expect(detectMention("@app", 4)).toEqual({ start: 0, query: "app" });
  });

  it("detects a bare @ with an empty query", () => {
    expect(detectMention("look at @", 9)).toEqual({ start: 8, query: "" });
  });

  it("allows path characters in the query", () => {
    expect(detectMention("@src/main/in", 12)).toEqual({ start: 0, query: "src/main/in" });
  });

  it("does NOT trigger on an email (@ not after whitespace)", () => {
    expect(detectMention("me@host.com", 11)).toBeNull();
  });

  it("stops at a space after the query", () => {
    expect(detectMention("@src ", 5)).toBeNull();
  });

  it("uses the caret position, not the whole string", () => {
    expect(detectMention("@src and more", 4)).toEqual({ start: 0, query: "src" });
  });
});

describe("rankFileMentions", () => {
  const files = [
    "package.json",
    "src/main/index.ts",
    "src/renderer/App.tsx",
    "src/renderer/file-mention.ts",
    "README.md",
    "apps/desktop/src/index.ts",
  ];

  it("returns top-level short paths for an empty query", () => {
    const r = rankFileMentions(files, "", 3);
    expect(r[0]).toBe("README.md"); // shortest
    expect(r).toContain("package.json");
  });

  it("ranks a name match above a path match", () => {
    const r = rankFileMentions(files, "index.ts");
    expect(r[0]).toMatch(/index\.ts$/);
  });

  it("matches by base-name prefix", () => {
    const r = rankFileMentions(files, "app");
    expect(r[0]).toBe("src/renderer/App.tsx");
  });

  it("matches a path fragment", () => {
    const r = rankFileMentions(files, "renderer");
    expect(r.every((p) => p.includes("renderer"))).toBe(true);
    expect(r.length).toBe(2);
  });

  it("fuzzy-matches subsequences", () => {
    const r = rankFileMentions(files, "fmt"); // f…m…t in file-mention.ts
    expect(r).toContain("src/renderer/file-mention.ts");
  });

  it("returns nothing for an unmatched query", () => {
    expect(rankFileMentions(files, "zzznope")).toEqual([]);
  });

  it("caps the result count", () => {
    expect(rankFileMentions(files, "s", 2).length).toBeLessThanOrEqual(2);
  });
});
