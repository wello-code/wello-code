import { describe, expect, it } from "vitest";
import { CONTEXT_WINDOW_1M, DEFAULT_CODE_MODEL, MODELS_1M_CONTEXT } from "@wello-code/contracts";
import {
  FALLBACK_CONTEXT_WINDOW,
  MODELS,
  STATUS_HIDDEN,
  contextWindowFor,
  listedModels,
  modelAvailability,
  pickerShelves,
} from "./models";

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

/**
 * Two shelves. The stable one is switched on from the service's side, so what
 * decides whether its models are in the picker is the status, not this build.
 */
describe("the stable shelf", () => {
  const STABLE = ["claude-opus-5.5-stable", "gpt-6.1-sol-stable"];
  const ordinary = MODELS.filter((m) => m.shelf !== "stable").map((m) => m.id);
  const everythingUp = Object.fromEntries(MODELS.map((m) => [m.id, "available"]));

  it("is two models, marked as such and nothing else is", () => {
    expect(MODELS.filter((m) => m.shelf === "stable").map((m) => m.id)).toEqual(STABLE);
  });

  it("is listed when the status names its models", () => {
    expect(listedModels(everythingUp).map((m) => m.id)).toEqual(MODELS.map((m) => m.id));
  });

  it("is NOT listed on silence: no status, or a status that has never heard of it", () => {
    // A build that shipped before the shelf was switched on, a service that does
    // not know the shelf, a status request that failed: two models that would
    // answer with an error must not be offered on a guess.
    const older = Object.fromEntries(ordinary.map((id) => [id, "available"]));
    for (const status of [null, undefined, {}, older]) {
      expect(listedModels(status).map((m) => m.id)).toEqual(ordinary);
    }
  });

  it("is not listed while the service hides it, whatever the availability says", () => {
    const hidden = { ...everythingUp, "claude-opus-5.5-stable": STATUS_HIDDEN, "gpt-6.1-sol-stable": STATUS_HIDDEN };
    expect(listedModels(hidden).map((m) => m.id)).toEqual(ordinary);
    // One of the two can be on without the other.
    const half = { ...everythingUp, "gpt-6.1-sol-stable": STATUS_HIDDEN };
    expect(listedModels(half).map((m) => m.id)).toEqual([...ordinary, "claude-opus-5.5-stable"]);
  });

  it("tells 'not offered' from 'not answering'", () => {
    // Taken off the list while it still works: not in the picker, and not an outage.
    const withdrawn = { ...everythingUp, "gpt-5.6-luna": `${STATUS_HIDDEN}:available` };
    expect(listedModels(withdrawn).map((m) => m.id)).not.toContain("gpt-5.6-luna");
    expect(modelAvailability(withdrawn, "gpt-5.6-luna")).toBe(true);
    // Never switched on: not in the picker, and it would not answer either.
    const off = { ...everythingUp, "claude-opus-5.5-stable": `${STATUS_HIDDEN}:unavailable` };
    expect(listedModels(off).map((m) => m.id)).not.toContain("claude-opus-5.5-stable");
    expect(modelAvailability(off, "claude-opus-5.5-stable")).toBe(false);
    // Hidden with nothing said about answering: no mark either way.
    expect(modelAvailability({ "gpt-5.6-luna": STATUS_HIDDEN }, "gpt-5.6-luna")).toBeNull();
  });

  it("never takes the model in use off the list", () => {
    // Named on the button and missing from the menu under it is the worst of
    // both: whatever the status says, what the next message goes to has a row.
    const withdrawn = { ...everythingUp, "gpt-5.6-luna": `${STATUS_HIDDEN}:available` };
    expect(listedModels(withdrawn, "gpt-5.6-luna").map((m) => m.id)).toContain("gpt-5.6-luna");
    // A stable model someone has chosen survives silence too, and keeps its shelf.
    const listed = listedModels(null, "claude-opus-5.5-stable");
    expect(listed.map((m) => m.id)).toEqual([...ordinary, "claude-opus-5.5-stable"]);
    expect(pickerShelves(listed)!.stable.map((m) => m.id)).toEqual(["claude-opus-5.5-stable"]);
    // It does not pull the rest of its shelf in with it.
    expect(listed.map((m) => m.id)).not.toContain("gpt-6.1-sol-stable");
    // An id that is not in the picker at all adds nothing.
    expect(listedModels(null, "some-future-model").map((m) => m.id)).toEqual(ordinary);
  });

  it("stays in the list when it is merely DOWN: an outage is shown, not hidden", () => {
    const down = { ...everythingUp, "claude-opus-5.5-stable": "unavailable" };
    expect(listedModels(down).map((m) => m.id)).toContain("claude-opus-5.5-stable");
    expect(modelAvailability(down, "claude-opus-5.5-stable")).toBe(false);
  });

  it("never empties the ordinary list over a status hiccup, and can hide one of its models", () => {
    expect(listedModels(null).length).toBe(ordinary.length);
    const one = listedModels({ "gpt-5.6-luna": STATUS_HIDDEN }).map((m) => m.id);
    expect(one).toEqual(ordinary.filter((id) => id !== "gpt-5.6-luna"));
  });

  it("is drawn as its own group, first, and only when there is something in it", () => {
    const both = pickerShelves(listedModels(everythingUp))!;
    expect(both.stable.map((m) => m.id)).toEqual(STABLE);
    expect(both.ordinary.map((m) => m.id)).toEqual(ordinary);
    // Nothing stable on offer: no groups at all, the picker looks as it always did.
    expect(pickerShelves(listedModels(null))).toBeNull();
  });

  it("is never what someone gets without choosing it", () => {
    expect(MODELS[0]!.shelf).toBeUndefined();
    expect(listedModels(everythingUp)[0]!.shelf).toBeUndefined();
  });

  it("says in each hint what the choice does to the allowance", () => {
    // The same bargain as Astra's hint: the cost is visible at the moment of
    // choosing, or the model should not be on the list.
    for (const m of MODELS.filter((x) => x.shelf === "stable")) expect(m.hint, m.id).toMatch(/лимит/i);
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

  it("offers Astra, and never as the default", () => {
    // Astra draws roughly five times the allowance per turn, so it may be on the
    // list but must never be what someone gets without choosing it.
    const ids = MODELS.map((m) => m.id);
    expect(ids).toContain("gpt-6-astra");
    expect(ids[0]).not.toBe("gpt-6-astra");
  });

  it("warns in the hint that Astra spends the allowance faster", () => {
    // The whole reason it is safe to offer: the cost is visible at the moment of
    // choosing. If this hint is ever emptied, the model should come off the list.
    const astra = MODELS.find((m) => m.id === "gpt-6-astra")!;
    expect(astra.hint).toMatch(/лимит/i);
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
    expect(contextWindowFor("gpt-6-astra", null)).toBe(400_000);
    expect(contextWindowFor("gpt-6.1-sol-stable", null)).toBe(400_000);
  });

  it("gives the stable Opus its million, like the other Opus", () => {
    expect(contextWindowFor("claude-opus-5.5-stable", 200_000)).toBe(CONTEXT_WINDOW_1M);
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

describe("the picker and the fallback agree", () => {
  it("offers the model that everything else falls back to, first", () => {
    // The engine's default, chat titles, commit messages, PR text and the handoff
    // all fall back to DEFAULT_CODE_MODEL. If the picker's first entry were a
    // different model, a person would be on one model and those calls on another
    // — which is how a withdrawn model kept being used.
    expect(MODELS[0]!.id).toBe(DEFAULT_CODE_MODEL);
  });

  it("offers only the models we currently serve on the fast-cache path", () => {
    // The short list is temporary (2026-08-08). Astra joined it on 2026-09-05
    // after a measured agentic session: the cached prefix was read back on 8 of
    // 10 turns, which is the bar this list exists to enforce. A model that made
    // every turn re-read the whole conversation would drain a month's allowance
    // in days, and that is why the list is pinned rather than open.
    //
    // The two stable models joined on 2026-10-07 on the same bar, measured in a
    // real agent turn of this app (read a file, write a file, run a command):
    // from the second step on, both read the whole earlier conversation back
    // from the cache instead of paying for it again.
    expect(MODELS.map((m) => m.id)).toEqual([
      "claude-opus-5",
      "gpt-5.6-luna",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
      "gpt-6-astra",
      "claude-opus-5.5-stable",
      "gpt-6.1-sol-stable",
    ]);
  });
});
