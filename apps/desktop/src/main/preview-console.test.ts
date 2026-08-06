import { describe, expect, it } from "vitest";
import { ConsoleTail, consoleLine } from "./preview-console";

describe("consoleLine (preview console → agent-readable tail)", () => {
  it("keeps warnings and errors, in both event shapes Electron has shipped", () => {
    // Numeric legacy levels…
    expect(consoleLine(2, "Slow network detected")).toBe("[warn] Slow network detected");
    expect(consoleLine(3, "Uncaught TypeError: x is not a function")).toBe(
      "[error] Uncaught TypeError: x is not a function",
    );
    // …and the string levels of the event-object shape.
    expect(consoleLine("warning", "deprecated API")).toBe("[warn] deprecated API");
    expect(consoleLine("error", "boom")).toBe("[error] boom");
  });

  it("drops plain logs — noise must not flush real problems out of the tail", () => {
    expect(consoleLine(1, "app started")).toBeNull();
    expect(consoleLine("info", "hello")).toBeNull();
    expect(consoleLine("debug", "tick")).toBeNull();
    expect(consoleLine(undefined, "who knows")).toBeNull();
  });

  it("collapses whitespace and caps the length", () => {
    expect(consoleLine("error", "  a\n\n  b\tc  ")).toBe("[error] a b c");
    const long = "x".repeat(1000);
    expect(consoleLine("error", long)!.length).toBeLessThanOrEqual(310);
  });

  it("empty messages produce nothing", () => {
    expect(consoleLine("error", "")).toBeNull();
    expect(consoleLine("error", undefined)).toBeNull();
  });
});

describe("ConsoleTail", () => {
  it("keeps only the newest N lines, oldest first", () => {
    const tail = new ConsoleTail(3);
    for (const n of [1, 2, 3, 4, 5]) tail.push(`[error] e${n}`);
    expect(tail.snapshot()).toEqual(["[error] e3", "[error] e4", "[error] e5"]);
  });

  it("ignores nulls (filtered lines)", () => {
    const tail = new ConsoleTail(3);
    tail.push(null);
    tail.push("[warn] w1");
    expect(tail.snapshot()).toEqual(["[warn] w1"]);
  });
});
