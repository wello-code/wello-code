import { describe, expect, it } from "vitest";
import { classifyState } from "./state-store";

describe("classifyState (never silently discards)", () => {
  it("accepts the current index (version 2, chat ids)", () => {
    const v = classifyState(
      JSON.stringify({ version: 2, taskIds: ["a", "b"], workspace: null, activeId: "a" }),
    );
    expect(v).toEqual({ kind: "index", workspace: null, activeId: "a", taskIds: ["a", "b"] });
  });

  it("still accepts the old single-file version with a tasks array", () => {
    const v = classifyState(JSON.stringify({ version: 1, tasks: [], workspace: null, activeId: null }));
    expect(v.kind).toBe("ok");
  });

  it("drops a chat id that could escape the chats folder", () => {
    const v = classifyState(JSON.stringify({ version: 2, taskIds: ["ok", "../../etc/passwd"] }));
    expect(v).toMatchObject({ kind: "index", taskIds: ["ok"] });
  });

  it("backs up corrupt JSON instead of dropping it", () => {
    expect(classifyState("{not json")).toEqual({ kind: "backup", reason: "corrupt" });
    expect(classifyState("")).toEqual({ kind: "backup", reason: "corrupt" });
  });

  it("backs up a NEWER version (a downgrade round-trip must not lose history)", () => {
    const v = classifyState(JSON.stringify({ version: 3, tasks: [{ id: "a" }] }));
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
