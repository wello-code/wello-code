import { describe, expect, it } from "vitest";
import { formatLine, shouldRotate } from "./logger";

describe("formatLine", () => {
  const at = new Date("2026-07-20T10:00:00.000Z");

  it("stamps, levels and pads so columns line up across levels", () => {
    expect(formatLine("info", "started", undefined, at)).toBe(
      "2026-07-20T10:00:00.000Z INFO  started\n",
    );
    expect(formatLine("error", "boom", undefined, at)).toBe(
      "2026-07-20T10:00:00.000Z ERROR boom\n",
    );
  });

  it("keeps an Error's stack — the only part worth having in a bug report", () => {
    const err = new Error("kaboom");
    err.stack = "Error: kaboom\n    at somewhere";
    expect(formatLine("error", "failed", err, at)).toBe(
      "2026-07-20T10:00:00.000Z ERROR failed Error: kaboom\n    at somewhere\n",
    );
  });

  it("falls back to name+message when a thrown Error carries no stack", () => {
    const err = new Error("no stack");
    err.stack = undefined;
    expect(formatLine("warn", "odd", err, at)).toContain("Error: no stack");
  });

  it("serialises plain meta as JSON", () => {
    expect(formatLine("info", "ctx", { a: 1 }, at)).toBe(
      '2026-07-20T10:00:00.000Z INFO  ctx {"a":1}\n',
    );
  });

  it("never throws on circular meta — logging must not become the failure", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatLine("info", "loop", circular, at)).not.toThrow();
    expect(formatLine("info", "loop", circular, at)).toContain("[unserialisable meta]");
  });

  it("always ends with exactly one newline", () => {
    expect(formatLine("info", "x", undefined, at).match(/\n/g)).toHaveLength(1);
  });
});

describe("shouldRotate", () => {
  it("rotates once the incoming line would push past the cap", () => {
    expect(shouldRotate(900, 200, 1000)).toBe(true);
  });

  it("stays put while there is room", () => {
    expect(shouldRotate(700, 200, 1000)).toBe(false);
  });

  it("never rotates an empty file, even for a line larger than the cap", () => {
    // Otherwise a single oversized entry would roll on every write and we would
    // keep truncating to nothing.
    expect(shouldRotate(0, 5000, 1000)).toBe(false);
  });
});
