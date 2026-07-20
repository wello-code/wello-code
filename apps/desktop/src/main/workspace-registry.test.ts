import { describe, expect, it } from "vitest";
import { isKnownWorkspace, registerWorkspace } from "./workspace-registry";

const win = process.platform === "win32";

describe("workspace registry (A5 confused-deputy guard)", () => {
  it("rejects a folder that was never opened", () => {
    expect(isKnownWorkspace(win ? "C:\\Users\\x\\never" : "/home/x/never")).toBe(false);
  });

  it("accepts a folder after it is registered", () => {
    const p = win ? "C:\\Users\\x\\proj-a" : "/home/x/proj-a";
    registerWorkspace(p);
    expect(isKnownWorkspace(p)).toBe(true);
  });

  it("normalizes path form (separators, redundant segments, Windows case)", () => {
    const p = win ? "C:\\Users\\x\\Proj-B" : "/home/x/proj-b";
    registerWorkspace(p);
    const variant = win ? "c:\\users\\x\\proj-b" : "/home/x/sub/../proj-b";
    expect(isKnownWorkspace(variant)).toBe(true);
  });

  it("does not register empty or nullish paths", () => {
    registerWorkspace("");
    registerWorkspace(null);
    registerWorkspace(undefined);
    expect(isKnownWorkspace(win ? "C:\\Users\\x\\proj-c" : "/home/x/proj-c")).toBe(false);
  });
});
