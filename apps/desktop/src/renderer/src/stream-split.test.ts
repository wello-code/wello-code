import { describe, expect, it } from "vitest";
import { splitStreaming } from "./stream-split";

/** ~1.2 KB each, so a few of them are past the "worth splitting" threshold. */
const para = (n: number): string => `Абзац ${n}. ${"текст ".repeat(200)}`;

describe("splitStreaming", () => {
  it("leaves a short answer whole — there is nothing to save", () => {
    const text = `${para(1)}\n\n${para(2)}`;
    expect(splitStreaming(text)).toEqual({ head: "", tail: text });
  });

  it("splits a long answer at the last blank line", () => {
    const text = [para(1), para(2), para(3), para(4), "Пишу дал"].join("\n\n");
    const { head, tail } = splitStreaming(text);
    expect(tail).toBe("Пишу дал");
    expect(head + "\n" + tail).toBe(text);
    expect(head).toContain("Абзац 4");
  });

  it("never cuts inside an unfinished code block", () => {
    const text = [
      para(1),
      para(2),
      para(3),
      "```ts\nconst a = 1;\n\nconst b = 2;\n\nconst c = ",
    ].join("\n\n");
    const { head, tail } = splitStreaming(text);
    expect(head).not.toContain("```");
    expect(tail.startsWith("```ts")).toBe(true);
  });

  it("puts a finished code block in the head and keeps the prose after it live", () => {
    const text = [
      para(1),
      para(2),
      para(3),
      "```ts\nconst a = 1;\n```",
      "Проверил на реальном про",
    ].join("\n\n");
    const { head, tail } = splitStreaming(text);
    expect(head).toContain("```ts");
    expect(head.match(/```/g)).toHaveLength(2); // the fence is closed inside the head
    expect(tail).toBe("Проверил на реальном про");
  });

  it("does not cut a list in half (a blank line inside one is not a border)", () => {
    const text = [para(1), para(2), para(3), "- один", "- два", "- три"].join("\n\n");
    const { head, tail } = splitStreaming(text);
    // The boundary is the blank line BEFORE the list, so the whole list stays live.
    expect(head).not.toContain("- один");
    expect(tail).toContain("- один");
    expect(tail).toContain("- три");
  });

  it("does not cut a table in half", () => {
    const text = [
      para(1),
      para(2),
      para(3),
      "| a | b |\n| - | - |\n| 1 | 2 |",
      "| 3 | 4 |",
    ].join("\n\n");
    const { tail } = splitStreaming(text);
    expect(tail.startsWith("| a | b |")).toBe(true);
  });

  it("loses nothing: head + tail is always the original text", () => {
    const text = [para(1), para(2), para(3), "```js\nlet x = 1;\n```", para(4), "хво"].join("\n\n");
    const { head, tail } = splitStreaming(text);
    expect(`${head}\n${tail}`).toBe(text);
  });
});
