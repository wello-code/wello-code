import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const userData = mkdtempSync(join(tmpdir(), "wello-dirs-"));
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

import {
  MAX_WORKSPACE_EXTRA_DIRS,
  addWorkspaceDir,
  getWorkspacePrefs,
  removeWorkspaceDir,
  resetWorkspacePrefsForTests,
  setWorkspaceTrust,
} from "./workspace-prefs";

afterAll(() => {
  // The prefs file is written by a background queue, so on Windows the last
  // write can still hold the handle when the suite ends. Cleanup failing must
  // not fail the run.
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    /* a temp dir the OS will collect anyway */
  }
});
beforeEach(() => resetWorkspacePrefsForTests());

describe("extra project folders (working across two repositories)", () => {
  it("attaches a folder and reports it back for the run", async () => {
    const res = await addWorkspaceDir("C:/proj", "D:/other-repo");
    expect(res).toEqual({ ok: true, dirs: ["D:/other-repo"] });
    expect((await getWorkspacePrefs("C:/proj")).extraDirs).toEqual(["D:/other-repo"]);
  });

  it("works in a folder whose trust question was never answered", async () => {
    // Attaching is an explicit act in the OS picker; it must not silently
    // vanish just because the trust modal has not been through yet.
    const res = await addWorkspaceDir("C:/undecided", "D:/lib");
    expect(res.ok).toBe(true);
  });

  it("refuses the project itself and anything already inside it", async () => {
    expect(await addWorkspaceDir("C:/proj", "C:/proj")).toEqual({
      ok: false,
      reason: "inside_project",
    });
    expect(await addWorkspaceDir("C:/proj", "C:/proj/src")).toEqual({
      ok: false,
      reason: "inside_project",
    });
    // A look-alike sibling is a DIFFERENT folder and stays allowed.
    expect((await addWorkspaceDir("C:/proj", "C:/project-two")).ok).toBe(true);
  });

  it("refuses a duplicate whatever the path spelling", async () => {
    await addWorkspaceDir("C:/proj", "D:/Other-Repo");
    expect(await addWorkspaceDir("C:/proj", "d:\\other-repo\\")).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("stops at the ceiling instead of attaching a whole drive", async () => {
    for (let i = 0; i < MAX_WORKSPACE_EXTRA_DIRS; i++) {
      expect((await addWorkspaceDir("C:/proj", `D:/repo-${i}`)).ok).toBe(true);
    }
    expect(await addWorkspaceDir("C:/proj", "D:/one-more")).toEqual({
      ok: false,
      reason: "too_many",
    });
  });

  it("detaches by path, case-insensitively, and leaves the rest", async () => {
    await addWorkspaceDir("C:/proj", "D:/a");
    await addWorkspaceDir("C:/proj", "D:/b");
    expect(await removeWorkspaceDir("C:/proj", "d:\\A")).toEqual(["D:/b"]);
  });

  it("survives a trust toggle — where the folders go is not a trust decision", async () => {
    await setWorkspaceTrust("C:/proj", true);
    await addWorkspaceDir("C:/proj", "D:/other-repo");
    await setWorkspaceTrust("C:/proj", false);
    expect((await getWorkspacePrefs("C:/proj")).extraDirs).toEqual(["D:/other-repo"]);
    await setWorkspaceTrust("C:/proj", true);
    expect((await getWorkspacePrefs("C:/proj")).extraDirs).toEqual(["D:/other-repo"]);
  });
});

describe("attaching before the trust question was answered", () => {
  it("does not count as a trust decision — the folder is still asked about", async () => {
    await addWorkspaceDir("C:/fresh", "D:/lib");
    const prefs = await getWorkspacePrefs("C:/fresh");
    expect(prefs.decided).toBe(false); // the trust modal still owes an answer
    expect(prefs.trusted).toBe(false); // and until then the folder is restricted
    expect(prefs.extraDirs).toEqual(["D:/lib"]);
  });

  it("answering trust afterwards settles it and keeps the folders", async () => {
    await addWorkspaceDir("C:/fresh2", "D:/lib");
    await setWorkspaceTrust("C:/fresh2", true);
    const prefs = await getWorkspacePrefs("C:/fresh2");
    expect(prefs.decided).toBe(true);
    expect(prefs.trusted).toBe(true);
    expect(prefs.extraDirs).toEqual(["D:/lib"]);
  });
});
