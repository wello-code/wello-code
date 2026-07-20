import { describe, expect, it } from "vitest";
import { mergeQueued } from "./queued";

describe("mergeQueued", () => {
  it("returns null for an empty batch", () => {
    expect(mergeQueued([])).toBeNull();
  });

  it("joins texts FIFO with blank lines and omits redundant shown", () => {
    const m = mergeQueued([
      { fullText: "первое", content: {} },
      { fullText: "второе", content: {} },
      { fullText: "третье", content: {} },
    ]);
    expect(m?.fullText).toBe("первое\n\nвторое\n\nтретье");
    expect(m?.content.shown).toBeUndefined();
    expect(m?.content.images).toBeUndefined();
    expect(m?.content.attachments).toBeUndefined();
  });

  it("keeps shown when any message displays differently from its fullText", () => {
    const m = mergeQueued([
      { fullText: "полный текст со вставкой [paste.txt]", content: { shown: "кратко" } },
      { fullText: "второе", content: {} },
    ]);
    expect(m?.content.shown).toBe("кратко\n\nвторое");
    expect(m?.fullText).toBe("полный текст со вставкой [paste.txt]\n\nвторое");
  });

  it("concatenates images and attachments across the batch", () => {
    const m = mergeQueued<{ label: string }>([
      { fullText: "a", content: { images: ["i1"], attachments: [{ label: "f1" }] } },
      { fullText: "b", content: { images: ["i2", "i3"] } },
      { fullText: "c", content: { attachments: [{ label: "f2" }] } },
    ]);
    expect(m?.content.images).toEqual(["i1", "i2", "i3"]);
    expect(m?.content.attachments).toEqual([{ label: "f1" }, { label: "f2" }]);
  });
});
