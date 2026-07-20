import { describe, expect, it } from "vitest";
import {
  columnsFor,
  computeDock,
  distribute,
  restorablePanels,
  SEP_SIZE,
  TILE_MIN_H,
  TILE_MIN_W,
} from "./dock-layout";

describe("columnsFor", () => {
  it("keeps 1-2 panels in a single column at any width", () => {
    expect(columnsFor(["a"], 1200)).toEqual([["a"]]);
    expect(columnsFor(["a", "b"], 1200)).toEqual([["a", "b"]]);
  });

  it("splits 3 panels as 2+1 and 4 as 2+2 when the dock is wide enough", () => {
    expect(columnsFor(["a", "b", "c"], 560)).toEqual([["a", "b"], ["c"]]);
    expect(columnsFor(["a", "b", "c", "d"], 800)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("stays single-column below the two-column threshold", () => {
    expect(columnsFor(["a", "b", "c", "d"], 559)).toEqual([["a", "b", "c", "d"]]);
  });

  it("returns nothing for an empty set", () => {
    expect(columnsFor([], 800)).toEqual([]);
  });
});

describe("distribute", () => {
  it("shares proportionally by weight", () => {
    expect(distribute(600, [1, 2], 0)).toEqual([200, 400]);
  });

  it("pins items to the floor and redistributes the rest", () => {
    const [a, b] = distribute(500, [1, 100], 200);
    expect(a).toBe(200);
    expect(b).toBe(300);
  });

  it("squeezes equally when even the floors do not fit", () => {
    expect(distribute(300, [1, 5], 200)).toEqual([150, 150]);
  });

  it("keeps pinning while lifted floors push others under the floor", () => {
    const out = distribute(650, [1, 1, 100], 200);
    expect(out[0]).toBe(200);
    expect(out[1]).toBe(200);
    expect(out[2]).toBe(250);
    expect(out.reduce((s, v) => s + v, 0)).toBeCloseTo(650);
  });
});

describe("computeDock", () => {
  const base = { width: 800, height: 600, maximized: null, split: 0.5, weights: {} };

  it("gives a single panel the whole dock", () => {
    const l = computeDock({ ...base, panels: ["terminal"] });
    expect(l.rects["terminal"]).toEqual({ left: 0, top: 0, width: 800, height: 600 });
    expect(l.seps).toEqual([]);
  });

  it("stacks two panels 50/50 with one row rail between them", () => {
    const l = computeDock({ ...base, panels: ["review", "terminal"] });
    expect(l.rects["review"]).toEqual({ left: 0, top: 0, width: 800, height: 300 });
    expect(l.rects["terminal"]).toEqual({ left: 0, top: 300, width: 800, height: 300 });
    expect(l.seps).toHaveLength(1);
    expect(l.seps[0]).toMatchObject({ kind: "row", a: "review", b: "terminal" });
    expect(l.seps[0]!.rect.top).toBe(300 - SEP_SIZE / 2);
  });

  it("lays four panels out as a 2×2 grid with two row rails and one column rail", () => {
    const l = computeDock({ ...base, panels: ["a", "b", "c", "d"] });
    expect(l.columns).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(l.rects["a"]).toEqual({ left: 0, top: 0, width: 400, height: 300 });
    expect(l.rects["d"]).toEqual({ left: 400, top: 300, width: 400, height: 300 });
    expect(l.seps.filter((s) => s.kind === "row")).toHaveLength(2);
    expect(l.seps.filter((s) => s.kind === "col")).toHaveLength(1);
  });

  it("gives the third panel its own full-height column", () => {
    const l = computeDock({ ...base, panels: ["a", "b", "c"] });
    expect(l.rects["c"]).toEqual({ left: 400, top: 0, width: 400, height: 600 });
  });

  it("falls back to one column with equal heights when the dock is narrow", () => {
    const l = computeDock({ ...base, width: 400, panels: ["a", "b", "c"] });
    expect(l.columns).toEqual([["a", "b", "c"]]);
    expect(l.rects["a"]!.height).toBe(200);
    expect(l.rects["b"]!.top).toBe(200);
  });

  it("clamps the column split so both columns keep the minimum width", () => {
    const l = computeDock({ ...base, panels: ["a", "b", "c"], width: 600, split: 0.05 });
    expect(l.rects["a"]!.width).toBe(TILE_MIN_W);
    expect(l.rects["c"]!.width).toBe(600 - TILE_MIN_W);
  });

  it("maximized: full dock for one tile, the rest hidden (null), no rails", () => {
    const l = computeDock({ ...base, panels: ["a", "b", "c"], maximized: "b" });
    expect(l.rects["b"]).toEqual({ left: 0, top: 0, width: 800, height: 600 });
    expect(l.rects["a"]).toBeNull();
    expect(l.rects["c"]).toBeNull();
    expect(l.seps).toEqual([]);
  });

  it("ignores a maximized id that is not open", () => {
    const l = computeDock({ ...base, panels: ["a"], maximized: "b" });
    expect(l.rects["a"]).toEqual({ left: 0, top: 0, width: 800, height: 600 });
  });

  it("respects row weights and enforces the height floor", () => {
    const l = computeDock({
      ...base,
      panels: ["a", "b"],
      weights: { a: 500, b: 100 },
    });
    expect(l.rects["a"]!.height).toBe(400);
    expect(l.rects["b"]!.height).toBe(TILE_MIN_H);
  });

  it("opens a weightless newcomer at the column mean, not as a sliver", () => {
    // After a drag, weights are pixel-scaled (e.g. 500). A newcomer defaulting
    // to 1 would collapse to the floor; the mean keeps tiles comparable.
    const l = computeDock({
      ...base,
      height: 900,
      panels: ["a", "b"],
      weights: { a: 500 },
    });
    expect(l.rects["a"]!.height).toBeCloseTo(450);
    expect(l.rects["b"]!.height).toBeCloseTo(450);
  });
});

describe("restorablePanels", () => {
  it("keeps known tool panels, drops file tabs and junk, dedupes", () => {
    expect(
      restorablePanels({
        panels: ["terminal", "file:src/a.ts", "review", "terminal", "nope"],
      }),
    ).toEqual(["terminal", "review"]);
  });

  it("handles a missing set", () => {
    expect(restorablePanels({})).toEqual([]);
  });
});
