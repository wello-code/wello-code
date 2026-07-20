import { describe, expect, it } from "vitest";
import { classifyState } from "./state-store";

describe("classifyState (never silently discards)", () => {
  it("accepts the current version with a tasks array", () => {
    const v = classifyState(JSON.stringify({ version: 1, tasks: [], workspace: null, activeId: null }));
    expect(v.kind).toBe("ok");
  });

  it("backs up corrupt JSON instead of dropping it", () => {
    expect(classifyState("{not json")).toEqual({ kind: "backup", reason: "corrupt" });
    expect(classifyState("")).toEqual({ kind: "backup", reason: "corrupt" });
  });

  it("backs up a NEWER version (a downgrade round-trip must not lose history)", () => {
    const v = classifyState(JSON.stringify({ version: 2, tasks: [{ id: "a" }] }));
    expect(v).toEqual({ kind: "backup", reason: "newer" });
  });

  it("backs up an untrusted shape (version ok but tasks missing)", () => {
    expect(classifyState(JSON.stringify({ version: 1, tasks: "nope" }))).toEqual({
      kind: "backup",
      reason: "unknown",
    });
    expect(classifyState(JSON.stringify({ hello: "world" }))).toEqual({
      kind: "backup",
      reason: "unknown",
    });
  });
});
