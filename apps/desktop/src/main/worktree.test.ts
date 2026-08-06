import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
  createTaskWorktree,
  removeTaskWorktree,
  worktreeBranch,
  worktreeStem,
  worktreesRoot,
} from "./worktree";

const pexec = promisify(execFile);
const NOW = new Date("2026-08-06T12:00:00Z");

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

async function makeRepo(withCommit = true): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "wello-wt-origin-"));
  roots.push(dir);
  const git = (...args: string[]) => pexec("git", ["-C", dir, ...args], { windowsHide: true });
  await pexec("git", ["init", dir], { windowsHide: true });
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  if (withCommit) {
    await fs.writeFile(join(dir, "app.txt"), "v1\n");
    await git("add", "-A");
    await git("commit", "-m", "init");
  }
  return dir;
}

function makeUserData(): string {
  const dir = mkdtempSync(join(tmpdir(), "wello-wt-ud-"));
  roots.push(dir);
  return dir;
}

describe("worktree naming (pure)", () => {
  it("stems keep letters (Cyrillic included) and stamp the moment", () => {
    const stem = worktreeStem("C:/dev/мой проект", NOW);
    expect(stem).toContain("мой-проект");
    expect(stem).toContain("20260806");
  });

  it("branches are latin-only — they travel to remotes", () => {
    // A fully Cyrillic name degrades to the timestamp, never to an empty ref.
    expect(worktreeBranch("мой-проект-20260806120000")).toBe("wello/20260806120000");
    expect(worktreeBranch("только-кириллица")).toBe("wello/task");
  });

  it("a latin stem becomes the branch verbatim under wello/", () => {
    expect(worktreeBranch("shop-20260806120000")).toBe("wello/shop-20260806120000");
  });
});

describe("createTaskWorktree / removeTaskWorktree (real git CLI)", () => {
  it("creates an isolated copy on its own wello/ branch; edits stay out of the origin", async () => {
    const origin = await makeRepo();
    const userData = makeUserData();
    const res = await createTaskWorktree(origin, userData, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.path.startsWith(worktreesRoot(userData))).toBe(true);
    expect(res.branch.startsWith("wello/")).toBe(true);
    // The copy is a real checkout of the same repo… (autocrlf may vary — the
    // BYTES of the checkout are git policy, the CONTENT is what we assert)
    const norm = (s: string): string => s.replace(/\r\n/g, "\n");
    expect(norm(await fs.readFile(join(res.path, "app.txt"), "utf8"))).toBe("v1\n");
    // …edits there do NOT appear in the origin's working tree.
    await fs.writeFile(join(res.path, "app.txt"), "v2-from-copy\n");
    expect(norm(await fs.readFile(join(origin, "app.txt"), "utf8"))).toBe("v1\n");
    // The branch exists in the shared repo (mergeable with normal tools).
    const { stdout } = await pexec("git", ["-C", origin, "branch", "--list", res.branch], {
      windowsHide: true,
    });
    expect(stdout).toContain(res.branch);
  });

  it("removal: clean copy goes away, dirty copy is refused and stays", async () => {
    const origin = await makeRepo();
    const userData = makeUserData();
    const created = await createTaskWorktree(origin, userData, NOW);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Dirty: uncommitted edit → refuse, folder survives.
    await fs.writeFile(join(created.path, "app.txt"), "unsaved work\n");
    const refused = await removeTaskWorktree(origin, created.path);
    expect(refused.ok).toBe(false);
    expect(refused.dirty).toBe(true);
    expect(await fs.readFile(join(created.path, "app.txt"), "utf8")).toBe("unsaved work\n");

    // Clean it up (restore the file) → removal succeeds and the folder is gone.
    await pexec("git", ["-C", created.path, "checkout", "--", "."], { windowsHide: true });
    const removed = await removeTaskWorktree(origin, created.path);
    expect(removed.ok).toBe(true);
    await expect(fs.stat(created.path)).rejects.toThrow();
  });

  it("refuses politely on a non-repo and on an unborn repo", async () => {
    const plain = mkdtempSync(join(tmpdir(), "wello-wt-plain-"));
    roots.push(plain);
    const userData = makeUserData();
    const notRepo = await createTaskWorktree(plain, userData, NOW);
    expect(notRepo.ok).toBe(false);
    if (!notRepo.ok) expect(notRepo.error).toContain("git-репозиторием");

    const unborn = await makeRepo(false);
    const noCommits = await createTaskWorktree(unborn, userData, NOW);
    expect(noCommits.ok).toBe(false);
    if (!noCommits.ok) expect(noCommits.error).toContain("коммит");
  });
});
