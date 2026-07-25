import type { ChangeSummary } from "../shared/ipc-api";
import * as gitService from "./git";
import * as snapshot from "./snapshot";

/**
 * Change-review dispatcher: a real git repo uses git; a plain folder falls back
 * to the per-task snapshot store. One place decides which backend, so the
 * renderer just branches on the `backing` field.
 *
 * Both backends are TASK-SCOPED. The git one used to ignore `taskId` and report
 * the whole uncommitted diff of the folder, which lied in both directions: a
 * project opened with unsaved work showed "изменено 13 файлов" for a run that
 * never happened, and «Отменить» offered to discard the USER's own work. Now a
 * per-task baseline (snapshot.ensureGitBaseline, captured at the task's first
 * run) records what was already dirty, so the summary subtracts anything the
 * agent hasn't touched and revert restores those files to their pre-task bytes
 * instead of resetting them to HEAD.
 *
 * Tasks that predate the baseline have none — they keep the old, unfiltered
 * behaviour rather than silently showing nothing.
 */

async function isRepo(cwd: string): Promise<boolean> {
  return (await gitService.status(cwd)).isRepo;
}

export async function summary(cwd: string, taskId: string): Promise<ChangeSummary> {
  const git = await gitService.changeSummary(cwd);
  if (git.isRepo) {
    const base = await snapshot.loadGitBaseline(taskId);
    if (!base) return { ...git, backing: "git" };
    const files = [];
    for (const f of git.files) {
      const meta = base.files[f.path];
      // Dirty before the task AND unchanged since → the user's own work, not ours.
      if (meta && (await snapshot.matchesGitBaseline(cwd, f.path, meta))) continue;
      files.push(f);
    }
    return {
      ...git,
      backing: "git",
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  }
  // Snapshot fallback — but keep the reason visible: "git is not installed" and
  // "plain folder" render differently (install hint vs the init button).
  const snap = await snapshot.snapshotSummary(taskId, cwd);
  return { ...snap, gitMissing: !(await gitService.gitAvailable()) };
}

export async function diff(
  cwd: string,
  taskId: string,
  file: string,
): Promise<{ diff: string; untracked: boolean }> {
  if (await isRepo(cwd)) return gitService.diff(cwd, file);
  return snapshot.snapshotDiff(taskId, cwd, file);
}

export async function revertFile(cwd: string, taskId: string, file: string): Promise<void> {
  if (await isRepo(cwd)) {
    // The file already had uncommitted edits when the task started: put THOSE
    // bytes back. `git checkout` would reset to HEAD and take the user's work
    // with it — the agent only made the delta on top.
    if (await snapshot.restoreGitBaselineFile(taskId, cwd, file)) return;
    return gitService.revertFile(cwd, file);
  }
  return snapshot.snapshotRevertFile(taskId, cwd, file);
}

export async function revertAll(cwd: string, taskId: string): Promise<void> {
  if (await isRepo(cwd)) {
    // Revert exactly what the review shows — never the pre-existing changes it
    // filters out.
    const view = await summary(cwd, taskId);
    for (const f of view.files) await revertFile(cwd, taskId, f.path).catch(() => undefined);
    return;
  }
  return snapshot.snapshotRevertAll(taskId, cwd);
}
