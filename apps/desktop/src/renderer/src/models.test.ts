import { describe, expect, it } from "vitest";
import { FALLBACK_CONTEXT_WINDOW, MODELS, contextWindowFor } from "./models";

describe("the picker", () => {
  it("offers the GPT family alongside Claude", () => {
    const ids = MODELS.map((m) => m.id);
    expect(ids).toContain("gpt-5.6-terra");
    expect(ids).toContain("gpt-5.6-sol");
  });

  it("does NOT offer the broken member of that family", () => {
    // luna errors on every request; offering it would be a button that always fails.
    expect(MODELS.map((m) => m.id)).not.toContain("gpt-5.6-luna");
  });

  it("keeps Claude first, because that is what the product runs on", () => {
    expect(MODELS[0]!.id.startsWith("claude-")).toBe(true);
  });

  it("has no duplicates and no empty labels", () => {
    const ids = MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const m of MODELS) {
      expect(m.label.trim(), m.id).not.toBe("");
      expect(m.hint.trim(), m.id).not.toBe("");
    }
  });
});

describe("contextWindowFor", () => {
  it("gives the GPT family its real 400K window", () => {
    expect(contextWindowFor("gpt-5.6-terra", null)).toBe(400_000);
    expect(contextWindowFor("gpt-5.6-sol", null)).toBe(400_000);
  });

  it("OVERRIDES the engine when the engine is guessing", () => {
    // The engine reports its own default for a model it has never heard of. A
    // 400K context shown against a 200K window reads as full at half.
    expect(contextWindowFor("gpt-5.6-terra", 200_000)).toBe(400_000);
  });

  it("trusts the engine for the models it actually knows", () => {
    expect(contextWindowFor("claude-sonnet-5", 1_000_000)).toBe(1_000_000);
    expect(contextWindowFor("claude-opus-5", 200_000)).toBe(200_000);
  });

  it("falls back only when nothing has been reported yet", () => {
    expect(contextWindowFor("claude-sonnet-5", null)).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(contextWindowFor("claude-sonnet-5", 0)).toBe(FALLBACK_CONTEXT_WINDOW);
  });

  it("never returns zero, whatever it is handed", () => {
    for (const model of ["", "unknown-model", ...MODELS.map((m) => m.id)]) {
      for (const reported of [null, 0, -5, 123]) {
        expect(contextWindowFor(model, reported), `${model}/${reported}`).toBeGreaterThan(0);
      }
    }
  });
});
