import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abortConflict,
  addRemote,
  branchInfo,
  changeSummary,
  commitAll,
  conflictInfo,
  createBranch,
  deleteBranch,
  diff,
  fetch as gitFetch,
  gitAvailable,
  init,
  listBranches,
  pull,
  push,
  renameBranch,
  stashCount,
  stashPop,
  stashPush,
  status,
  switchBranch,
  syncInfo,
  validateBranchPrefix,
} from "./git";
import { readFile } from "node:fs/promises";
import { buildGitCredentialEnv } from "../shared/github";

/**
 * Integration tests against the REAL git CLI in a temp repo — the exact surface
 * stage 1 ships (init → branch → status/diff → commit), including a Cyrillic
 * filename end-to-end (the quotePath=false contract).
 */
const pexec = promisify(execFile);
let root: string;

const hasGit = await gitAvailable();
const d = hasGit ? describe : describe.skip;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "wello-git-"));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

d("local git stage 1 (real CLI)", () => {
  it("a plain folder is not a repo (and git itself is present)", async () => {
    const st = await status(root);
    expect(st.isRepo).toBe(false);
    expect(st.gitMissing ?? false).toBe(false);
    const bi = await branchInfo(root);
    expect(bi).toMatchObject({ isRepo: false, branch: null, unborn: false, gitMissing: false });
  });

  it("init turns it into a repo with an unborn HEAD", async () => {
    const res = await init(root);
    expect(res.ok).toBe(true);
    const bi = await branchInfo(root);
    expect(bi.isRepo).toBe(true);
    expect(bi.unborn).toBe(true);
    expect(bi.branch).toBeNull();
  });

  it("a Cyrillic file flows status → diff → commit", async () => {
    // Commit identity is repo-local so the test never depends on global config.
    await pexec("git", ["-C", root, "config", "user.name", "Тест"], { windowsHide: true });
    await pexec("git", ["-C", root, "config", "user.email", "test@example.com"], {
      windowsHide: true,
    });

    await writeFile(join(root, "заметки по проекту.md"), "первая строка\nвторая строка\n", "utf8");

    const st = await status(root);
    expect(st.isRepo).toBe(true);
    expect(st.files.map((f) => f.path)).toContain("заметки по проекту.md");

    const summary = await changeSummary(root);
    const row = summary.files.find((f) => f.path === "заметки по проекту.md");
    expect(row?.additions).toBe(2);

    const dd = await diff(root, "заметки по проекту.md");
    expect(dd.untracked).toBe(true);
    expect(dd.diff).toContain("+первая строка");

    const commit = await commitAll(root, "добавить заметки по проекту");
    expect(commit.ok).toBe(true);
    expect(commit.shortHash).toMatch(/^[0-9a-f]{4,}$/);

    // Clean tree + a born HEAD afterwards.
    expect((await changeSummary(root)).files).toHaveLength(0);
    const bi = await branchInfo(root);
    expect(bi.unborn).toBe(false);
    expect(typeof bi.branch).toBe("string");

    // The message travelled as its own argv element, Cyrillic intact.
    const { stdout } = await pexec("git", ["-C", root, "log", "-1", "--pretty=%s"], {
      windowsHide: true,
    });
    expect(stdout.trim()).toBe("добавить заметки по проекту");
  });

  it("an empty commit message is rejected without touching git", async () => {
    expect((await commitAll(root, "   ")).ok).toBe(false);
  });

  it("committing with nothing to commit reports git's own words", async () => {
    const res = await commitAll(root, "пустой коммит");
    expect(res.ok).toBe(false);
    expect(res.stderr ?? "").not.toBe("");
  });
});

/* ── Stage 2: fully OFFLINE remote sync against a local bare origin ───────── */

d("remote sync + branches (local bare origin, file://)", () => {
  let work: string; // the "user's" clone
  let other: string; // a second clone to commit "from the other side"
  let bare: string;
  let bareUrl: string;

  const setIdentity = async (cwd: string): Promise<void> => {
    await pexec("git", ["-C", cwd, "config", "user.name", "Тест"], { windowsHide: true });
    await pexec("git", ["-C", cwd, "config", "user.email", "t@example.com"], { windowsHide: true });
  };
  const commitFile = async (cwd: string, name: string, text: string, msg: string): Promise<void> => {
    await writeFile(join(cwd, name), text, "utf8");
    const res = await commitAll(cwd, msg);
    expect(res.ok).toBe(true);
  };

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), "wello-git2-"));
    work = join(base, "work");
    other = join(base, "other");
    bare = join(base, "origin.git");
    bareUrl = pathToFileURL(bare).href;
    await pexec("git", ["init", "--bare", bare], { windowsHide: true });
    await pexec("git", ["init", work], { windowsHide: true });
    await setIdentity(work);
    await commitFile(work, "readme.md", "старт\n", "первый коммит");
  });
  afterAll(async () => {
    await rm(join(work, ".."), { recursive: true, force: true }).catch(() => undefined);
  });

  it("no origin yet → addRemote attaches it exactly once", async () => {
    expect((await syncInfo(work)).remote).toBeNull();
    expect((await addRemote(work, bareUrl)).ok).toBe(true);
    expect((await syncInfo(work)).remote).toBe(bareUrl);
    // a second attach refuses instead of stacking origins
    expect((await addRemote(work, bareUrl)).ok).toBe(false);
  });

  it("first push publishes the branch and sets the upstream", async () => {
    expect((await syncInfo(work)).upstream).toBe(false);
    const res = await push(work);
    expect(res.ok).toBe(true);
    const si = await syncInfo(work);
    expect(si.upstream).toBe(true);
    expect(si.ahead).toBe(0);
    expect(si.behind).toBe(0);
  }, 30_000);

  it("local commit → ahead 1; push zeroes it", async () => {
    await commitFile(work, "a.txt", "a\n", "локальный коммит");
    expect((await syncInfo(work)).ahead).toBe(1);
    expect((await push(work)).ok).toBe(true);
    expect((await syncInfo(work)).ahead).toBe(0);
  }, 30_000);

  it("a commit from the other side → fetch shows behind 1, pull --ff-only takes it", async () => {
    await pexec("git", ["clone", bareUrl, other], { windowsHide: true });
    await setIdentity(other);
    await commitFile(other, "b.txt", "b\n", "коммит со стороны");
    expect((await push(other)).ok).toBe(true);

    // before fetch the local refs know nothing new
    expect((await syncInfo(work)).behind).toBe(0);
    expect((await gitFetch(work)).ok).toBe(true);
    const si = await syncInfo(work);
    expect(si.behind).toBe(1);
    expect(si.ahead).toBe(0);

    expect((await pull(work)).ok).toBe(true);
    expect((await syncInfo(work)).behind).toBe(0);
  }, 30_000);

  it("diverged branches: pull --ff-only refuses with git's own words, no merge", async () => {
    await commitFile(other, "c.txt", "c\n", "ещё со стороны");
    expect((await push(other)).ok).toBe(true);
    await commitFile(work, "d.txt", "d\n", "своё локальное");
    expect((await gitFetch(work)).ok).toBe(true);
    const si = await syncInfo(work);
    expect(si.ahead).toBe(1);
    expect(si.behind).toBe(1);

    const res = await pull(work);
    expect(res.ok).toBe(false);
    expect(res.stderr ?? "").not.toBe("");
    // still diverged — nothing was merged behind the user's back
    const after = await syncInfo(work);
    expect(after.ahead).toBe(1);
    expect(after.behind).toBe(1);
    // heal for the next tests: push our side over after a real pull --rebase
    await pexec("git", ["-C", work, "pull", "--rebase"], { windowsHide: true });
    expect((await push(work)).ok).toBe(true);
  }, 30_000);

  it("a dirty tree blocks switch with code=dirty (git switch never runs)", async () => {
    await writeFile(join(work, "dirty.txt"), "не закоммичено\n", "utf8");
    const res = await switchBranch(work, "main");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("dirty");
    // clean up the dirt for the branch tests below
    await rm(join(work, "dirty.txt"), { force: true });
  });

  it("a Cyrillic branch flows create → switch → push (upstream set)", async () => {
    const name = "тема/новая-фича";
    expect((await createBranch(work, name)).ok).toBe(true);
    const list = await listBranches(work);
    expect(list.branches).toContain(name);
    expect(list.current).toBe(name);

    // hop away and back — plain switch on a clean tree
    const main = list.branches.find((b) => b !== name)!;
    expect((await switchBranch(work, main)).ok).toBe(true);
    expect((await switchBranch(work, name)).ok).toBe(true);

    expect((await push(work)).ok).toBe(true);
    const si = await syncInfo(work);
    expect(si.upstream).toBe(true);
    expect(si.ahead).toBe(0);
  }, 30_000);

  it("branch names that could read as flags are refused before git runs", async () => {
    expect((await createBranch(work, "-oops")).ok).toBe(false);
    expect((await switchBranch(work, "--force")).ok).toBe(false);
    expect((await addRemote(work, "--upload-pack=x")).ok).toBe(false);
  });

  it("branch-prefix validation: empty and sane pass, junk is refused", async () => {
    expect((await validateBranchPrefix(work, "")).ok).toBe(true);
    expect((await validateBranchPrefix(work, "   ")).ok).toBe(true);
    expect((await validateBranchPrefix(work, "wello/")).ok).toBe(true);
    expect((await validateBranchPrefix(work, "фича-")).ok).toBe(true);
    expect((await validateBranchPrefix(work, "wel lo/")).ok).toBe(false);
    expect((await validateBranchPrefix(work, "wello..")).ok).toBe(false);
    expect((await validateBranchPrefix(work, "-wello/")).ok).toBe(false);
  });
});

d("merge conflicts (real CLI)", () => {
  let repo: string;

  const run = (args: string[]): Promise<{ stdout: string }> =>
    pexec("git", ["-C", repo, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    });

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "wello-conflict-"));
    await run(["init", "-b", "main"]).catch(() => run(["init"]));
    await run(["config", "user.email", "t@example.com"]);
    await run(["config", "user.name", "T"]);
    await writeFile(join(repo, "story.txt"), "base line\n");
    await run(["add", "-A"]);
    await run(["commit", "-m", "base"]);
    await run(["checkout", "-b", "feature"]);
    await writeFile(join(repo, "story.txt"), "feature line\n");
    await run(["commit", "-am", "feature change"]);
    await run(["checkout", "-"]);
    await writeFile(join(repo, "story.txt"), "main line\n");
    await run(["commit", "-am", "main change"]);
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  });

  it("a clean repo reports no conflict", async () => {
    expect(await conflictInfo(repo)).toEqual({ operation: null, files: [] });
  });

  it("a failed merge reports the operation and the unmerged file", async () => {
    await run(["merge", "feature"]).catch(() => undefined); // conflict → non-zero exit
    const info = await conflictInfo(repo);
    expect(info.operation).toBe("merge");
    expect(info.files).toEqual(["story.txt"]);
  });

  it("abortConflict aborts the merge and the repo is clean again", async () => {
    const res = await abortConflict(repo);
    expect(res.ok).toBe(true);
    expect(await conflictInfo(repo)).toEqual({ operation: null, files: [] });
  });

  it("abort with nothing in flight refuses politely", async () => {
    const res = await abortConflict(repo);
    expect(res.ok).toBe(false);
    expect(res.stderr).toBeTruthy();
  });
});

d("branch management + stash (real CLI)", () => {
  let repo: string;
  const run = (args: string[]): Promise<{ stdout: string }> =>
    pexec("git", ["-C", repo, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    });

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "wello-brmgmt-"));
    await run(["init", "-b", "main"]).catch(() => run(["init"]));
    await run(["config", "user.email", "t@example.com"]);
    await run(["config", "user.name", "T"]);
    await writeFile(join(repo, "f.txt"), "hi\n");
    await run(["add", "-A"]);
    await run(["commit", "-m", "base"]);
  });
  afterAll(async () => {
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  });

  it("renames the current branch", async () => {
    const res = await renameBranch(repo, "", "trunk");
    expect(res.ok).toBe(true);
    const list = await listBranches(repo);
    expect(list.current).toBe("trunk");
    expect(list.branches).toContain("trunk");
  });

  it("creates then deletes a merged branch", async () => {
    await createBranch(repo, "feature-x"); // switches onto it (no new commits → merged)
    await switchBranch(repo, "trunk");
    const res = await deleteBranch(repo, "feature-x", false);
    expect(res.ok).toBe(true);
    expect((await listBranches(repo)).branches).not.toContain("feature-x");
  });

  it("refuses to delete the current branch", async () => {
    const res = await deleteBranch(repo, "trunk", false);
    expect(res.ok).toBe(false);
    expect(res.stderr).toMatch(/текущую/i);
  });

  it("safe-delete refuses an unmerged branch; force removes it", async () => {
    await createBranch(repo, "wip");
    await writeFile(join(repo, "wip.txt"), "unmerged\n");
    await run(["add", "-A"]);
    await run(["commit", "-m", "wip commit"]);
    await switchBranch(repo, "trunk");
    const safe = await deleteBranch(repo, "wip", false);
    expect(safe.ok).toBe(false);
    expect(safe.stderr).toMatch(/not fully merged|не слит/i);
    const forced = await deleteBranch(repo, "wip", true);
    expect(forced.ok).toBe(true);
  });

  it("stashes and pops working-tree changes", async () => {
    await writeFile(join(repo, "f.txt"), "changed\n");
    expect((await status(repo)).files.length).toBeGreaterThan(0);
    const pushed = await stashPush(repo);
    expect(pushed.ok).toBe(true);
    expect((await status(repo)).files.length).toBe(0);
    expect(await stashCount(repo)).toBe(1);
    const popped = await stashPop(repo);
    expect(popped.ok).toBe(true);
    // The restored change is back (CRLF-tolerant — Windows git may normalize EOL).
    expect((await readFile(join(repo, "f.txt"), "utf8")).trim()).toBe("changed");
    expect(await stashCount(repo)).toBe(0);
  });

  it("stash push with a clean tree reports nothing to save", async () => {
    await run(["checkout", "--", "."]).catch(() => undefined);
    const res = await stashPush(repo);
    expect(res.ok).toBe(false);
  });
});

/* ── The GitHub credential bridge (env-injected config, offline) ───────────── */

d("git credential bridge (GIT_CONFIG env, real CLI)", () => {
  let repo: string;
  let bare: string;
  const bridge = buildGitCredentialEnv("gho_test_token");

  beforeAll(async () => {
    const base = await mkdtemp(join(tmpdir(), "wello-git3-"));
    repo = join(base, "repo");
    bare = join(base, "origin.git");
    await pexec("git", ["init", "--bare", bare], { windowsHide: true });
    await pexec("git", ["init", repo], { windowsHide: true });
    await pexec("git", ["-C", repo, "config", "user.name", "T"], { windowsHide: true });
    await pexec("git", ["-C", repo, "config", "user.email", "t@e.com"], { windowsHide: true });
    await writeFile(join(repo, "a.txt"), "a\n", "utf8");
    await commitAll(repo, "первый");
    await addRemote(repo, pathToFileURL(bare).href);
  });
  afterAll(async () => {
    await rm(join(repo, ".."), { recursive: true, force: true }).catch(() => undefined);
  });

  it("the env-injected helper reaches real git as command-line config", async () => {
    // `git config --get` returns the LAST value for the key — ours, which
    // proves GIT_CONFIG_COUNT/KEY/VALUE actually land in the child process.
    const { stdout } = await pexec(
      "git",
      ["-C", repo, "config", "--get", "credential.https://github.com.helper"],
      { env: { ...process.env, ...bridge }, windowsHide: true },
    );
    expect(stdout.trim()).toContain("$WELLO_GH_TOKEN");
    expect(stdout.trim()).toContain("username=x-access-token");
  });

  it("push/fetch/pull to a NON-GitHub remote are untouched by the bridge env", async () => {
    // The helper is scoped to https://github.com — a file:// origin must work
    // exactly as before with the bridge env present.
    expect((await push(repo, bridge)).ok).toBe(true);
    expect((await gitFetch(repo, bridge)).ok).toBe(true);
    expect((await pull(repo, bridge)).ok).toBe(true);
    const si = await syncInfo(repo);
    expect(si.upstream).toBe(true);
    expect(si.ahead).toBe(0);
  }, 30_000);
});
