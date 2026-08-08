import { describe, expect, it } from "vitest";
import { CONTEXT_WINDOW_1M, MODELS_1M_CONTEXT } from "@wello-code/contracts";
import { FALLBACK_CONTEXT_WINDOW, MODELS, contextWindowFor, modelAvailability } from "./models";

describe("modelAvailability (picker health marks)", () => {
  // A live shape from the gateway's public status: catalog ids with dots.
  const status = {
    "claude-sonnet-5": "available",
    "claude-opus-4.8": "unavailable",
    "gpt-5.6-terra": "available",
  };

  it("matches across the dot/dash id split (opus-4.8 ↔ opus-4-8)", () => {
    expect(modelAvailability(status, "claude-opus-4-8")).toBe(false);
    expect(modelAvailability(status, "claude-sonnet-5")).toBe(true);
    expect(modelAvailability(status, "gpt-5.6-terra")).toBe(true);
  });

  it("unknown model or missing status marks NOTHING (three-valued)", () => {
    // A status hiccup must never read as «все модели лежат».
    expect(modelAvailability(status, "some-future-model")).toBeNull();
    expect(modelAvailability(null, "claude-sonnet-5")).toBeNull();
    expect(modelAvailability(undefined, "claude-sonnet-5")).toBeNull();
  });

  it("only an explicit non-available value counts as down", () => {
    expect(modelAvailability({ "claude-sonnet-5": "degraded" }, "claude-sonnet-5")).toBe(false);
  });
});

describe("the picker", () => {
  it("offers the GPT family alongside Claude", () => {
    const ids = MODELS.map((m) => m.id);
    expect(ids).toContain("gpt-5.6-terra");
    expect(ids).toContain("gpt-5.6-sol");
  });

  it("offers the whole GPT family", () => {
    // luna was excluded while it answered errors to everything; it works now
    // (checked with a full agent turn: streamed tool call, tool result, answer),
    // so leaving it out would be hiding a working, cheaper option.
    for (const id of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]) {
      expect(MODELS.map((m) => m.id), id).toContain(id);
    }
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

  it("gives the million-token models their real window, whatever the engine says", () => {
    // The engine does not know these ids either — it answers with its 200K
    // default, and the gauge used to believe it. Opus 5 read «163к свободно»
    // while the same model was carrying 313K prompts (2026-08-08).
    for (const id of MODELS_1M_CONTEXT) {
      expect(contextWindowFor(id, 200_000), id).toBe(CONTEXT_WINDOW_1M);
      expect(contextWindowFor(id, null), id).toBe(CONTEXT_WINDOW_1M);
    }
  });

  it("keeps every model in the picker off the flat fallback", () => {
    // The fallback exists for a model nobody listed; a model a person can SELECT
    // should always have a real number behind its ring.
    for (const m of MODELS) {
      expect(contextWindowFor(m.id, null), m.id).not.toBe(FALLBACK_CONTEXT_WINDOW);
    }
  });

  it("still trusts the engine where we have no opinion", () => {
    expect(contextWindowFor("some-future-model", 300_000)).toBe(300_000);
    expect(contextWindowFor("some-future-model", null)).toBe(FALLBACK_CONTEXT_WINDOW);
    expect(contextWindowFor("some-future-model", 0)).toBe(FALLBACK_CONTEXT_WINDOW);
  });

  it("never returns zero, whatever it is handed", () => {
    for (const model of ["", "unknown-model", ...MODELS.map((m) => m.id)]) {
      for (const reported of [null, 0, -5, 123]) {
        expect(contextWindowFor(model, reported), `${model}/${reported}`).toBeGreaterThan(0);
      }
    }
  });
});
