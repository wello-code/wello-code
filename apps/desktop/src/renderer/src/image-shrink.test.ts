import { describe, expect, it } from "vitest";
import { MAX_IMAGE_EDGE, RECODE_MIN_BYTES, planShrink } from "./image-shrink";

const KB = 1024;

describe("planShrink", () => {
  it("fits the long side to the ceiling the API uses anyway", () => {
    const plan = planShrink("image/png", 4000 * KB, 3840, 2160)!; // a 4K screenshot
    expect(plan.size.width).toBe(MAX_IMAGE_EDGE);
    expect(plan.size.height).toBe(Math.round((2160 * MAX_IMAGE_EDGE) / 3840));
    expect(plan.size.width / plan.size.height).toBeCloseTo(3840 / 2160, 2);
    expect(plan.type).toBe("image/webp");
  });

  it("does the same for a portrait picture", () => {
    const plan = planShrink("image/png", 4000 * KB, 2000, 4000)!;
    expect(plan.size.height).toBe(MAX_IMAGE_EDGE);
    expect(plan.size.width).toBe(Math.round((2000 * MAX_IMAGE_EDGE) / 4000));
  });

  it("cuts a 4K screenshot to about a sixth of its pixels", () => {
    const { size } = planShrink("image/png", 4000 * KB, 3840, 2160)!;
    expect((3840 * 2160) / (size.width * size.height)).toBeGreaterThan(5);
  });

  it("never upscales, and leaves a small file completely alone", () => {
    expect(planShrink("image/png", 80 * KB, 640, 480)).toBeNull();
    expect(planShrink("image/png", 200 * KB, MAX_IMAGE_EDGE, 900)).toBeNull();
  });

  it("re-encodes a heavy picture that is already within the ceiling", () => {
    const plan = planShrink("image/png", RECODE_MIN_BYTES + 1, 1400, 900)!;
    expect(plan.size).toEqual({ width: 1400, height: 900 }); // same pixels
    expect(plan.type).toBe("image/webp");
    // …but not one that is already in that format.
    expect(planShrink("image/webp", RECODE_MIN_BYTES + 1, 1400, 900)).toBeNull();
  });

  it("leaves an animated GIF alone — decoding one keeps a single frame", () => {
    expect(planShrink("image/gif", 5000 * KB, 3840, 2160)).toBeNull();
  });

  it("refuses nonsense dimensions instead of dividing by zero", () => {
    expect(planShrink("image/png", 100 * KB, 0, 0)).toBeNull();
    expect(planShrink("image/png", 100 * KB, Number.NaN, 100)).toBeNull();
  });
});
