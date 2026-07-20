import { describe, expect, it } from "vitest";
import { boundsOnScreen } from "./window-state";

const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const secondary = { workArea: { x: 1920, y: 0, width: 1920, height: 1040 } };

describe("boundsOnScreen", () => {
  it("accepts a window well inside a display", () => {
    expect(boundsOnScreen({ x: 100, y: 100, width: 1280, height: 800 }, [primary])).toBe(true);
  });

  it("accepts a window on a secondary display", () => {
    expect(boundsOnScreen({ x: 2000, y: 50, width: 1280, height: 800 }, [primary, secondary])).toBe(
      true,
    );
  });

  it("rejects a window stranded off every display (unplugged monitor)", () => {
    // Was on the secondary monitor, which is now gone.
    expect(boundsOnScreen({ x: 2600, y: 100, width: 1280, height: 800 }, [primary])).toBe(false);
  });

  it("rejects a window that only shares a 1px sliver with a display", () => {
    expect(boundsOnScreen({ x: -1279, y: 100, width: 1280, height: 800 }, [primary])).toBe(false);
  });

  it("treats size-only bounds (no x/y) as always valid — they'll be centered", () => {
    expect(boundsOnScreen({ width: 1280, height: 800 }, [primary])).toBe(true);
  });
});
