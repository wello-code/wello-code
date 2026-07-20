import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  ChangeSummary,
  CommitResult,
  GitBranchInfo,
  GitBranchList,
  GitFile,
  GitStatus,
  GitSyncInfo,
} from "../shared/ipc-api";

/**
 * Safe Git via the native CLI: argv arrays only (never a shell string), non-interactive
 * env (no prompts / pager / optional locks). Used to show what the agent changed, to
 * revert rejected files during review, and (stage 1 of local git) to init a repo and
 * commit everything as "accept the changes".
 */
const pexec = promisify(execFile);

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
};

/** Hard cap for NETWORK operations (fetch/push/pull) — a wedged remote must not
 *  hang the branch popover forever; the child is killed on expiry. */
const NET_TIMEOUT_MS = 120_000;

async function git(
  cwd: string,
  args: string[],
  opts?: { timeoutMs?: number; extraEnv?: Record<string, string> },
): Promise<string> {
  // core.quotePath=false → non-ASCII paths (Cyrillic filenames are everywhere for
  // this app's users) are emitted as raw UTF-8, not octal-escaped "\321\204…".
  // Without it, status/diff return mangled names the renderer can't match back,
  // so revert silently does nothing and diffs render empty.
  try {
    const { stdout } = await pexec("git", ["-c", "core.quotePath=false", "-C", cwd, ...args], {
      env: opts?.extraEnv ? { ...GIT_ENV, ...opts.extraEnv } : GIT_ENV,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      ...(opts?.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const } : {}),
    });
    return stdout;
  } catch (err) {
    if (opts?.timeoutMs && (err as { killed?: boolean } | null)?.killed) {
      throw new Error(
        `Превышено время ожидания (${Math.round(opts.timeoutMs / 1000)} с). Проверьте сеть и удалённый репозиторий.`,
      );
    }
    throw err;
  }
}

/** Whether an execFile failure means "git is not installed" (vs a git error). */
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Error text for the UI: stderr first (git's own words), stdout as the fallback. */
function errText(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string } | null;
  return (e?.stderr || e?.stdout || e?.message || "git failed").trim();
}

/**
 * Whether the git CLI exists on this machine — probed once per app session (PATH
 * changes mid-session are not a case worth re-probing for). Distinguishes the
 * "install Git to enable branches/commits" UI from the ordinary "not a repo".
 */
let gitProbe: Promise<boolean> | null = null;
export function gitAvailable(): Promise<boolean> {
  gitProbe ??= pexec("git", ["--version"], { env: GIT_ENV, windowsHide: true }).then(
    () => true,
    (err) => (isEnoent(err) ? false : true), // a weird exit still means the binary exists
  );
  return gitProbe;
}

/** Test seam: forget the cached probe so ENOENT/installed can both be simulated. */
export function resetGitProbeForTests(): void {
  gitProbe = null;
}

/** Resolve `file` under `cwd` and reject any path that escapes the workspace. */
function assertInside(cwd: string, file: string): string {
  const abs = resolve(cwd, file);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path escapes the workspace.");
  }
  return abs;
}

/**
 * The real path of `abs`, but only if it stays inside `cwd` after following any
 * symlinks — otherwise null. Used before READING an untracked file into a diff, so
 * a link pointing outside the repo can't leak external content into the review pane.
 * (Missing file → return `abs`: nothing to follow, and stat/read will just fail.)
 */
async function realInside(cwd: string, abs: string): Promise<string | null> {
  try {
    const [realTarget, realCwd] = await Promise.all([realpath(abs), realpath(cwd)]);
    const rel = relative(realCwd, realTarget);
    return rel !== "" && (rel.startsWith("..") || isAbsolute(rel)) ? null : realTarget;
  } catch {
    return abs;
  }
}

function classify(x: string, y: string): GitFile["status"] {
  if (x === "?" && y === "?") return "untracked";
  if (x === "R" || y === "R") return "renamed";
  if (x === "A" || y === "A") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

export async function status(cwd: string): Promise<GitStatus> {
  try {
    const out = await git(cwd, ["status", "--porcelain=v1", "-uall"]);
    const files: GitFile[] = [];
    for (const line of out.split("\n")) {
      if (line.length < 4) continue;
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      let path = line.slice(3);
      const arrow = path.indexOf(" -> ");
      if (arrow !== -1) path = path.slice(arrow + 4);
      path = path.trim().replace(/^"|"$/g, "");
      files.push({ path, status: classify(x, y) });
    }
    return { isRepo: true, files };
  } catch (err) {
    // "git is not installed" and "not a repository" are different UI states
    // (install hint vs the snapshot chip) — never collapse them.
    return { isRepo: false, files: [], gitMissing: isEnoent(err) };
  }
}

/**
 * The current branch for the chat status chip. Unborn HEAD (fresh repo, no
 * commits yet) → `branch: null, unborn: true` — the renderer words that as
 * «main (нет коммитов)». Not a repo / no git → isRepo:false (+ gitMissing).
 */
export async function branchInfo(cwd: string): Promise<GitBranchInfo> {
  if (!(await gitAvailable())) {
    return { isRepo: false, branch: null, unborn: false, gitMissing: true };
  }
  try {
    const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    return { isRepo: true, branch: branch || null, unborn: false, gitMissing: false };
  } catch {
    // Either not a repo at all, or a repo whose HEAD has no commits yet.
    try {
      await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
      return { isRepo: true, branch: null, unborn: true, gitMissing: false };
    } catch {
      return { isRepo: false, branch: null, unborn: false, gitMissing: false };
    }
  }
}

/**
 * "Accept the changes": stage everything and commit. The message travels as its
 * own argv element (never concatenated into a shell string). Failures come back
 * as `{ok:false, stderr}` — the panel shows git's own words (unset user.name/
 * email being the classic) instead of throwing.
 */
export async function commitAll(cwd: string, message: string): Promise<CommitResult> {
  const msg = message.trim();
  if (!msg) return { ok: false, stderr: "Пустое сообщение коммита." };
  try {
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-m", msg]);
    const shortHash = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
    return { ok: true, shortHash };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/** `git init` for a plain folder — flips the review dispatcher to the git backend. */
export async function init(cwd: string): Promise<CommitResult> {
  try {
    await git(cwd, ["init"]);
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/* ── Stage 2: remote sync + branches ─────────────────────────────────────────
   Auth is the credential helper's business (GCM on Git for Windows may pop a
   browser sign-in on the first push) — the env stays as is: GIT_TERMINAL_PROMPT=0
   only kills TERMINAL prompts, GCM works on top of it. */

/** A branch name the CLI can safely take as its own argv element. */
async function validBranchName(cwd: string, name: string): Promise<boolean> {
  if (!name.trim() || name.startsWith("-")) return false;
  try {
    await git(cwd, ["check-ref-format", "--branch", name]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Local-refs-only sync picture (NO network): origin url, whether the current
 * branch has an upstream, ahead/behind counts and the detached state (+ the
 * short hash for the «HEAD @ abc1234» chip).
 */
export async function syncInfo(cwd: string): Promise<GitSyncInfo> {
  let remote: string | null = null;
  try {
    remote = (await git(cwd, ["remote", "get-url", "origin"])).trim() || null;
  } catch {
    remote = null;
  }
  let detached = false;
  let head: string | null = null;
  try {
    const ref = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    detached = ref === "HEAD";
    if (detached) head = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  } catch {
    // unborn HEAD / not a repo — neither detached nor countable below
  }
  let upstream = false;
  let ahead = 0;
  let behind = 0;
  try {
    const counts = (
      await git(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
    ).trim();
    const [a, b] = counts.split(/\s+/).map((n) => Number(n) || 0);
    upstream = true;
    ahead = a ?? 0;
    behind = b ?? 0;
  } catch {
    // no upstream configured (or unborn) — counts stay 0
  }
  return { remote, upstream, ahead, behind, detached, head };
}

/** `git fetch origin --prune` — refreshes the ahead/behind picture.
 *  `extraEnv` (all three network ops): the app's GitHub credential bridge —
 *  github.com pushes/pulls authenticate with the stored token, no GCM window. */
export async function fetch(cwd: string, extraEnv?: Record<string, string>): Promise<CommitResult> {
  try {
    await git(cwd, ["fetch", "origin", "--prune"], { timeoutMs: NET_TIMEOUT_MS, extraEnv });
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/** Push; the branch's FIRST push publishes it (`--set-upstream origin HEAD`). */
export async function push(cwd: string, extraEnv?: Record<string, string>): Promise<CommitResult> {
  try {
    let hasUpstream = true;
    try {
      await git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
    } catch {
      hasUpstream = false;
    }
    const opts = { timeoutMs: NET_TIMEOUT_MS, extraEnv };
    if (hasUpstream) await git(cwd, ["push"], opts);
    else await git(cwd, ["push", "--set-upstream", "origin", "HEAD"], opts);
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/**
 * Fast-forward-only pull: diverged branches come back as an error with git's
 * own words — merging/rebasing on the user's behalf is deliberately NOT done.
 */
export async function pull(cwd: string, extraEnv?: Record<string, string>): Promise<CommitResult> {
  try {
    await git(cwd, ["pull", "--ff-only"], { timeoutMs: NET_TIMEOUT_MS, extraEnv });
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/** Local branches + the current one (null when detached/unborn). */
export async function listBranches(cwd: string): Promise<GitBranchList> {
  try {
    const out = await git(cwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]);
    const branches = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    let current: string | null = null;
    try {
      const ref = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
      current = ref && ref !== "HEAD" ? ref : null;
    } catch {
      current = null;
    }
    return { ok: true, branches, current };
  } catch (err) {
    return { ok: false, branches: [], current: null, stderr: errText(err) };
  }
}

/**
 * Switch branches — ONLY from a clean tree. Anything uncommitted reads as "the
 * agent's pending changes" in review, and that semantic must not leak across
 * branches: a dirty tree refuses with `code:"dirty"` BEFORE git runs.
 */
export async function switchBranch(cwd: string, name: string): Promise<CommitResult> {
  if (!(await validBranchName(cwd, name))) {
    return { ok: false, stderr: `Недопустимое имя ветки: ${name}` };
  }
  const st = await status(cwd);
  if (st.files.length > 0) {
    return { ok: false, code: "dirty", stderr: "Есть незакоммиченные изменения." };
  }
  try {
    await git(cwd, ["switch", name]);
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/** Create a branch (validated via check-ref-format) and switch onto it. */
export async function createBranch(cwd: string, name: string): Promise<CommitResult> {
  if (!(await validBranchName(cwd, name))) {
    return { ok: false, stderr: `Недопустимое имя ветки: ${name}` };
  }
  try {
    await git(cwd, ["switch", "-c", name]);
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/**
 * Check out a remote branch (`origin/<name>`) into a local tracking branch.
 * `git switch <name>` auto-creates a tracking branch when exactly one remote has
 * it (git's --guess). Clean-tree-only, same as a local switch — dirty refuses
 * with code:"dirty" before git runs.
 */
export async function checkoutRemote(cwd: string, name: string): Promise<CommitResult> {
  if (!(await validBranchName(cwd, name))) {
    return { ok: false, stderr: `Недопустимое имя ветки: ${name}` };
  }
  const st = await status(cwd);
  if (st.files.length > 0) {
    return { ok: false, code: "dirty", stderr: "Есть незакоммиченные изменения." };
  }
  try {
    // Local branch exists → plain switch; otherwise create it tracking origin/<name>.
    const local = await git(cwd, ["for-each-ref", `refs/heads/${name}`, "--format=%(refname:short)"]);
    if (local.trim() === name) await git(cwd, ["switch", name]);
    else await git(cwd, ["switch", "-c", name, "--track", `origin/${name}`]);
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/** Rename a local branch (the current one when `from` is omitted/blank). */
export async function renameBranch(cwd: string, from: string, to: string): Promise<CommitResult> {
  if (!(await validBranchName(cwd, to))) {
    return { ok: false, stderr: `Недопустимое имя ветки: ${to}` };
  }
  try {
    if (from.trim()) {
      if (!(await validBranchName(cwd, from))) {
        return { ok: false, stderr: `Недопустимое имя ветки: ${from}` };
      }
      await git(cwd, ["branch", "-m", from, to]);
    } else {
      await git(cwd, ["branch", "-m", to]); // rename current
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/**
 * Delete a local branch. Refuses to delete the current branch. Uses the SAFE
 * `-d` (git blocks it if the branch isn't merged) unless `force` is set, so an
 * unmerged branch isn't lost by accident — the caller surfaces git's own words
 * and can re-issue with force after confirming.
 */
export async function deleteBranch(cwd: string, name: string, force = false): Promise<CommitResult> {
  if (!(await validBranchName(cwd, name))) {
    return { ok: false, stderr: `Недопустимое имя ветки: ${name}` };
  }
  const current = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim();
  if (current === name) {
    return { ok: false, stderr: "Нельзя удалить текущую ветку — сначала переключитесь на другую." };
  }
  try {
    await git(cwd, ["branch", force ? "-D" : "-d", name]);
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/** Stash the working tree (includes untracked with -u). No-op-safe: git reports
 *  "No local changes to save" as a normal message, surfaced to the user. */
export async function stashPush(cwd: string): Promise<CommitResult> {
  try {
    const out = await git(cwd, ["stash", "push", "-u"]);
    if (/no local changes/i.test(out)) return { ok: false, stderr: "Нет изменений для стэша." };
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/** Re-apply and drop the most recent stash (`git stash pop`). */
export async function stashPop(cwd: string): Promise<CommitResult> {
  try {
    await git(cwd, ["stash", "pop"]);
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

/** How many stash entries exist (drives the «Вернуть стэш» button visibility). */
export async function stashCount(cwd: string): Promise<number> {
  try {
    const out = await git(cwd, ["stash", "list"]);
    return out.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

/**
 * Validate the branch-prefix SETTING: empty is fine; otherwise the prefix plus
 * a sample leaf ("x") must satisfy `git check-ref-format --branch` (a bare
 * "wello/" is not a ref name itself — it only ever prefixes one). Needs no
 * repo, just any existing cwd. No git installed → accept (nothing to check
 * against, and the popover can't create branches then anyway).
 */
export async function validateBranchPrefix(
  cwd: string,
  prefix: string,
): Promise<{ ok: boolean; error?: string }> {
  const p = prefix.trim();
  if (!p) return { ok: true };
  if (p.startsWith("-")) return { ok: false, error: "Префикс не может начинаться с «-»." };
  if (!(await gitAvailable())) return { ok: true };
  try {
    await git(cwd, ["check-ref-format", "--branch", `${p}x`]);
    return { ok: true };
  } catch {
    return { ok: false, error: `Недопустимый префикс ветки: ${p}` };
  }
}

/** Remote branches of origin (for the PR base select) — local refs, no network. */
export async function remoteBranches(cwd: string): Promise<string[]> {
  try {
    const out = await git(cwd, ["for-each-ref", "refs/remotes/origin", "--format=%(refname:short)"]);
    return out
      .split("\n")
      .map((s) => s.trim().replace(/^origin\//, ""))
      .filter((s) => s && s !== "HEAD");
  } catch {
    return [];
  }
}

/** The last commit's subject line (PR title prefill); null when unborn. */
export async function lastCommitSubject(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["log", "-1", "--pretty=%s"])).trim() || null;
  } catch {
    return null;
  }
}

/** Subject lines + a budgeted diff of base..HEAD — the PR-description generation feed. */
export async function rangeSummary(
  cwd: string,
  base: string,
): Promise<{ subjects: string[]; diff: string }> {
  if (!base.trim() || base.startsWith("-")) return { subjects: [], diff: "" };
  let subjects: string[] = [];
  try {
    subjects = (await git(cwd, ["log", "--pretty=%s", `origin/${base}..HEAD`]))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    /* base may not exist locally — the diff below may still work */
  }
  let diff = "";
  try {
    diff = await git(cwd, ["diff", "--no-color", `origin/${base}...HEAD`]);
  } catch {
    /* fine — subjects alone still give the model something */
  }
  const BUDGET = 48_000;
  return { subjects, diff: diff.length > BUDGET ? `${diff.slice(0, BUDGET)}\n… (дифф обрезан)` : diff };
}

/** The repo's origin URL, or null when none is attached. */
export async function originUrl(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["remote", "get-url", "origin"])).trim() || null;
  } catch {
    return null;
  }
}

/** Attach `origin` — only when the repo has none yet. */
export async function addRemote(cwd: string, url: string): Promise<CommitResult> {
  const u = url.trim();
  if (!u || u.startsWith("-")) return { ok: false, stderr: "Некорректный URL." };
  const existing = await git(cwd, ["remote", "get-url", "origin"]).catch(() => null);
  if (existing !== null) return { ok: false, stderr: "origin уже привязан." };
  try {
    await git(cwd, ["remote", "add", "origin", u]);
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}

async function isTracked(cwd: string, file: string): Promise<boolean> {
  try {
    await git(cwd, ["ls-files", "--error-unmatch", "--", file]);
    return true;
  } catch {
    return false;
  }
}

export async function diff(cwd: string, file: string): Promise<{ diff: string; untracked: boolean }> {
  const abs = assertInside(cwd, file);
  if (await isTracked(cwd, file)) {
    try {
      return { diff: await git(cwd, ["diff", "--no-color", "HEAD", "--", file]), untracked: false };
    } catch {
      // Unborn HEAD (fresh repo, file only staged, no commit yet): there is no
      // base revision to diff against — fall through and show it as all-added.
    }
  }
  // Untracked (or unborn HEAD): synthesize an all-added diff from the file contents.
  const real = await realInside(cwd, abs);
  const content = real ? await readFile(real, "utf8").catch(() => "") : "";
  const body = content.length ? content.replace(/\n$/, "").split("\n").map((l) => "+" + l).join("\n") : "";
  return { diff: `--- /dev/null\n+++ b/${file}\n${body}`, untracked: true };
}

export async function revertFile(cwd: string, file: string): Promise<void> {
  const abs = assertInside(cwd, file);
  if (await isTracked(cwd, file)) {
    await git(cwd, ["checkout", "HEAD", "--", file]);
  } else {
    await rm(abs, { force: true });
  }
}

/**
 * Per-file added/removed line counts for everything uncommitted (the change-set
 * card). Tracked files come from `diff --numstat HEAD`; untracked files count
 * their own lines as additions, matching how the diff view synthesizes them.
 */
export async function changeSummary(cwd: string): Promise<ChangeSummary> {
  const st = await status(cwd);
  if (!st.isRepo) {
    return { isRepo: false, gitMissing: st.gitMissing, files: [], additions: 0, deletions: 0 };
  }

  const counts = new Map<string, { additions: number; deletions: number }>();
  try {
    const out = await git(cwd, ["diff", "--numstat", "--no-color", "HEAD"]);
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [a, d, ...rest] = line.split("\t");
      let path = rest.join("\t");
      const arrow = path.indexOf(" => ");
      if (arrow !== -1) {
        // Rename lines look like "old => new" (possibly braced) — keep the new path.
        path = path.slice(arrow + 4).replace(/[{}]/g, "");
      }
      counts.set(path.trim().replace(/^"|"$/g, ""), {
        additions: a === "-" ? 0 : Number(a) || 0,
        deletions: d === "-" ? 0 : Number(d) || 0,
      });
    }
  } catch {
    // An unborn HEAD (fresh repo, no commits) has no diff base; fall through to
    // untracked counting, which covers every file in that case.
  }

  const files = await Promise.all(
    st.files.map(async (f) => {
      const known = counts.get(f.path);
      if (known) return { ...f, ...known };
      if (f.status === "untracked" || f.status === "added") {
        const real = await realInside(cwd, assertInside(cwd, f.path));
        const text = real ? await readFile(real, "utf8").catch(() => null) : null;
        const additions = text === null ? 0 : text.length === 0 ? 0 : text.replace(/\n$/, "").split("\n").length;
        return { ...f, additions, deletions: 0 };
      }
      return { ...f, additions: 0, deletions: 0 };
    }),
  );

  return {
    isRepo: true,
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/* ── Merge/rebase conflicts (detection + abort) ─────────────────────────────── */

/** Porcelain-v1 two-letter codes that mean "unmerged" (a conflicted path). */
const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

export interface GitConflictInfo {
  /** The in-progress operation, best-effort (null = none detected). */
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  /** Workspace-relative conflicted paths. */
  files: string[];
}

/** True when `git rev-parse -q --verify <ref>` resolves (e.g. MERGE_HEAD). */
async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "-q", "--verify", ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * The repo's conflict state: unmerged paths + which operation is in flight.
 * Cheap enough to ride along with every branch refresh; empty result for a
 * clean repo, a plain folder, or a machine without git.
 */
export async function conflictInfo(cwd: string): Promise<GitConflictInfo> {
  let out: string;
  try {
    out = await git(cwd, ["status", "--porcelain=v1"]);
  } catch {
    return { operation: null, files: [] };
  }
  const files: string[] = [];
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const code = `${line[0] ?? " "}${line[1] ?? " "}`;
    if (!CONFLICT_CODES.has(code)) continue;
    files.push(line.slice(3).trim().replace(/^"|"$/g, ""));
  }
  // The operation marker: rebase keeps a state DIR (no ref), the others a ref.
  let operation: GitConflictInfo["operation"] = null;
  try {
    const rebaseDirs = await git(cwd, ["rev-parse", "--git-path", "rebase-merge", "--git-path", "rebase-apply"]);
    const [mergeDir, applyDir] = rebaseDirs.split("\n").map((s) => s.trim());
    if ((mergeDir && existsSync(resolve(cwd, mergeDir))) || (applyDir && existsSync(resolve(cwd, applyDir)))) {
      operation = "rebase";
    } else if (await refExists(cwd, "MERGE_HEAD")) operation = "merge";
    else if (await refExists(cwd, "CHERRY_PICK_HEAD")) operation = "cherry-pick";
    else if (await refExists(cwd, "REVERT_HEAD")) operation = "revert";
  } catch {
    /* detection is best-effort */
  }
  return { operation, files };
}

/** Abort the in-progress merge/rebase/cherry-pick/revert (the escape hatch). */
export async function abortConflict(cwd: string): Promise<CommitResult> {
  const { operation } = await conflictInfo(cwd);
  if (!operation) return { ok: false, stderr: "Нет операции, которую можно прервать." };
  try {
    await git(cwd, [operation, "--abort"]);
    return { ok: true };
  } catch (err) {
    return { ok: false, stderr: errText(err) };
  }
}
