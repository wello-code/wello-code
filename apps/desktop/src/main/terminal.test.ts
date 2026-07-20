import { describe, expect, it } from "vitest";
import { incompleteEscapeStart } from "./terminal";

describe("incompleteEscapeStart (per-stream escape hold-back)", () => {
  it("returns -1 for chunks that end on a sequence boundary", () => {
    expect(incompleteEscapeStart("plain text")).toBe(-1);
    expect(incompleteEscapeStart("ok \x1b[32mgreen\x1b[0m")).toBe(-1);
    expect(incompleteEscapeStart("\x1b]0;title\x07tail")).toBe(-1);
    expect(incompleteEscapeStart("\x1b]0;title\x1b\\tail")).toBe(-1);
    expect(incompleteEscapeStart("")).toBe(-1);
  });

  it("finds a trailing dangling ESC and split CSI", () => {
    expect(incompleteEscapeStart("abc\x1b")).toBe(3);
    expect(incompleteEscapeStart("compiled ok \x1b[3")).toBe(12);
    expect(incompleteEscapeStart("\x1b[38;5;19")).toBe(0);
  });

  it("treats a trailing ESC inside an unterminated OSC as part of THAT sequence", () => {
    // The ESC here may be the first half of the ESC\ terminator — the cut must
    // start at the OSC's own ESC], not at the inner ESC.
    const s = "before\x1b]0;title\x1b";
    expect(incompleteEscapeStart(s)).toBe("before".length);
  });

  it("holds an unterminated OSC and a two-byte charset designation", () => {
    expect(incompleteEscapeStart("x\x1b]0;win")).toBe(1);
    expect(incompleteEscapeStart("y\x1b(")).toBe(1);
    expect(incompleteEscapeStart("y\x1b(B done")).toBe(-1);
  });

  it("gives up (ships as-is) on runaway sequences instead of holding forever", () => {
    expect(incompleteEscapeStart(`\x1b[${"9".repeat(2000)}`)).toBe(-1);
    expect(incompleteEscapeStart(`\x1b]0;${"t".repeat(9000)}`)).toBe(-1);
  });

  it("only the TAIL sequence matters — completed ones earlier are skipped", () => {
    const s = "\x1b[31mred\x1b[0m and \x1b[32";
    expect(incompleteEscapeStart(s)).toBe(s.indexOf("\x1b[32"));
  });
});
