import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, vi } from "vitest";

// review.ts reaches the snapshot store through its worker host, which asks
// Electron where userData is (and falls back to running in-process, which is
// what happens here — there is no built worker file next to a .ts source).
let userData = "";
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

import { summary, revertAll } from "./review";
import { configureSnapshots, ensureGitBaseline } from "./snapshot";
import { commitAll, init } from "./git";

const exec = promisify(execFile);

/**
 * The review pane in a GIT repo must show what THIS TASK changed — not every
 * uncommitted change in the folder. Getting that wrong shipped twice over:
 * a user without a subscription saw "изменено 13 файлов" for a run that never
 * ran, and «Отменить» was one click away from deleting their own unsaved work.
 */
beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), "wello-review-ud-"));
  configureSnapshots(userData);
});

async function newRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wello-review-ws-"));
  await init(dir);
  await exec("git", ["config", "user.email", "t@e.st"], { cwd: dir });
  await exec("git", ["config", "user.name", "Test"], { cwd: dir });
  return dir;
}

describe("review summary in a git repo (task-scoped)", () => {
  it("hides changes the user already had, and keeps what the agent touched", async () => {
    const ws = await newRepo();
    await writeFile(join(ws, "mine.txt"), "committed\n");
    await writeFile(join(ws, "shared.txt"), "committed\n");
    await commitAll(ws, "base");

    // The user's own uncommitted work, present BEFORE the task starts.
    await writeFile(join(ws, "mine.txt"), "my unsaved work\n");
    await writeFile(join(ws, "untracked-note.md"), "my notes\n");
    await writeFile(join(ws, "shared.txt"), "my edit\n");

    // Task starts here: this is what agent.start captures.
    await ensureGitBaseline("task-1", ws, ["mine.txt", "untracked-note.md", "shared.txt"]);

    // Nothing has run yet → the pane must be empty, not "3 files changed".
    expect((await summary(ws, "task-1")).files).toHaveLength(0);

    // Now the agent edits one pre-dirty file and creates a new one.
    await writeFile(join(ws, "shared.txt"), "my edit\nagent line\n");
    await writeFile(join(ws, "agent.txt"), "written by the agent\n");

    const after = await summary(ws, "task-1");
    expect(after.files.map((f) => f.path).sort()).toEqual(["agent.txt", "shared.txt"]);
    // Totals follow the filtered list, not git's raw numbers.
    expect(after.additions).toBe(after.files.reduce((n, f) => n + f.additions, 0));
  });

  it("revert restores the user's pre-task bytes instead of resetting to HEAD", async () => {
    const ws = await newRepo();
    await writeFile(join(ws, "shared.txt"), "committed\n");
    await commitAll(ws, "base");
    await writeFile(join(ws, "shared.txt"), "my unsaved work\n");
    await ensureGitBaseline("task-2", ws, ["shared.txt"]);
    await writeFile(join(ws, "shared.txt"), "my unsaved work\nagent line\n");
    await writeFile(join(ws, "agent.txt"), "agent only\n");

    await revertAll(ws, "task-2");

    // The agent's line is gone; the user's uncommitted work survived.
    expect(await readFile(join(ws, "shared.txt"), "utf8")).toBe("my unsaved work\n");
    expect(await readFile(join(ws, "agent.txt"), "utf8").catch(() => null)).toBeNull();
  });

  it("falls back to the whole diff for tasks that predate the baseline", async () => {
    const ws = await newRepo();
    await writeFile(join(ws, "a.txt"), "committed\n");
    await commitAll(ws, "base");
    await writeFile(join(ws, "a.txt"), "changed\n");
    // No ensureGitBaseline for this task id (an old chat): show everything
    // rather than silently claiming nothing changed.
    expect((await summary(ws, "legacy-task")).files.map((f) => f.path)).toEqual(["a.txt"]);
  });
});
