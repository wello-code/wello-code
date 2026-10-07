import { describe, expect, it } from "vitest";
import { modelStatusFromBody } from "./model-status";

describe("modelStatusFromBody", () => {
  it("reads one word per model out of the status", () => {
    const body = {
      updatedAt: "2026-10-07T12:00:00.000Z",
      models: {
        "claude-opus-5": { availability: "available" },
        "gpt-5.6-luna": { availability: "unavailable" },
        "gpt-5.6-sol": { availability: "degraded" },
      },
    };
    expect(modelStatusFromBody(body)).toEqual({
      "claude-opus-5": "available",
      "gpt-5.6-luna": "unavailable",
      "gpt-5.6-sol": "degraded",
    });
  });

  it("keeps both facts about a model the service does not offer", () => {
    // Whether it is offered and whether it answers are different questions: a
    // shelf that has not been switched on is hidden AND unavailable, a model
    // taken off the list while it still works is hidden and available.
    const body = {
      models: {
        "claude-opus-5.5-stable": { availability: "unavailable", hidden: true },
        "gpt-6.1-sol-stable": { availability: "available", hidden: true },
        "claude-opus-5": { availability: "available", hidden: false },
      },
    };
    expect(modelStatusFromBody(body)).toEqual({
      "claude-opus-5.5-stable": "hidden:unavailable",
      "gpt-6.1-sol-stable": "hidden:available",
      "claude-opus-5": "available",
    });
    // Hidden with nothing said about answering stays just hidden.
    expect(modelStatusFromBody({ models: { x: { hidden: true } } })).toEqual({ x: "hidden" });
  });

  it("is null when the body has no model table: no status is not an outage", () => {
    for (const body of [
      null,
      undefined,
      "ok",
      42,
      {},
      { models: null },
      { models: "x" },
      { models: [] },
    ]) {
      expect(modelStatusFromBody(body), JSON.stringify(body)).toBeNull();
    }
  });

  it("skips entries it cannot read instead of guessing", () => {
    const body = {
      models: { a: null, b: "available", c: { availability: 5 }, d: { availability: "available" } },
    };
    expect(modelStatusFromBody(body)).toEqual({ d: "available" });
  });
});
