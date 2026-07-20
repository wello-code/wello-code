import { describe, expect, it } from "vitest";
import { workspaceKey } from "./workspace-prefs";

describe("workspaceKey", () => {
  it("unifies separators, trailing slashes and case", () => {
    expect(workspaceKey("C:\\Foo\\Bar")).toBe("c:/foo/bar");
    expect(workspaceKey("c:/foo/bar/")).toBe("c:/foo/bar");
    expect(workspaceKey("C:/FOO/bar///")).toBe("c:/foo/bar");
  });

  it("keeps distinct folders distinct", () => {
    expect(workspaceKey("C:/a")).not.toBe(workspaceKey("C:/b"));
  });
});
