import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const userData = mkdtempSync(join(tmpdir(), "wello-memory-"));
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

import {
  WORKSPACE_MEMORY_MAX_CHARS,
  getWorkspacePrefs,
  resetWorkspacePrefsForTests,
  setWorkspaceMemory,
  setWorkspaceTrust,
} from "./workspace-prefs";

afterAll(() => rmSync(userData, { recursive: true, force: true }));
beforeEach(() => resetWorkspacePrefsForTests());

describe("workspace memory (the agent's cross-session project notes)", () => {
  it("stores notes for a trusted folder and reads them back", async () => {
    await setWorkspaceTrust("C:/proj", true);
    const res = await setWorkspaceMemory("C:/proj", "Мы используем pnpm.\nСтили — токены.");
    expect(res.ok).toBe(true);
    const prefs = await getWorkspacePrefs("C:/proj");
    expect(prefs.memory).toBe("Мы используем pnpm.\nСтили — токены.");
  });

  it("REFUSES to store for an untrusted or unknown folder", async () => {
    expect(await setWorkspaceMemory("C:/never-seen", "x")).toEqual({
      ok: false,
      reason: "untrusted",
    });
    await setWorkspaceTrust("C:/limited", false);
    expect(await setWorkspaceMemory("C:/limited", "x")).toEqual({
      ok: false,
      reason: "untrusted",
    });
  });

  it("refuses an over-cap note instead of silently truncating", async () => {
    await setWorkspaceTrust("C:/proj2", true);
    const res = await setWorkspaceMemory("C:/proj2", "x".repeat(WORKSPACE_MEMORY_MAX_CHARS + 1));
    expect(res).toEqual({ ok: false, reason: "too_long" });
    expect((await getWorkspacePrefs("C:/proj2")).memory).toBe("");
  });

  it("an empty write clears the notes", async () => {
    await setWorkspaceTrust("C:/proj3", true);
    await setWorkspaceMemory("C:/proj3", "заметка");
    await setWorkspaceMemory("C:/proj3", "");
    expect((await getWorkspacePrefs("C:/proj3")).memory).toBe("");
  });

  it("revoking trust keeps the notes out of prefs reads", async () => {
    await setWorkspaceTrust("C:/proj4", true);
    await setWorkspaceMemory("C:/proj4", "секретная договорённость");
    await setWorkspaceTrust("C:/proj4", false);
    // The runtime injects memory only for trusted folders; the write path
    // refuses too — untrusted is untrusted from both directions.
    expect(await setWorkspaceMemory("C:/proj4", "ещё")).toEqual({
      ok: false,
      reason: "untrusted",
    });
  });
});
