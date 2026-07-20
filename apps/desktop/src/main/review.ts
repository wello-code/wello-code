import type { ChangeSummary } from "../shared/ipc-api";
import * as gitService from "./git";
import * as snapshot from "./snapshot";

/**
 * Change-review dispatcher: a real git repo uses git (taskId ignored); a plain
 * folder falls back to the per-task snapshot store. One place decides which backend,
 * so the renderer just branches on the `backing` field.
 */

async function isRepo(cwd: string): Promise<boolean> {
  return (await gitService.status(cwd)).isRepo;
}

export async function summary(cwd: string, taskId: string): Promise<ChangeSummary> {
  const git = await gitService.changeSummary(cwd);
  if (git.isRepo) return { ...git, backing: "git" };
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
  if (await isRepo(cwd)) return gitService.revertFile(cwd, file);
  return snapshot.snapshotRevertFile(taskId, cwd, file);
}

export async function revertAll(cwd: string, taskId: string): Promise<void> {
  if (await isRepo(cwd)) {
    const git = await gitService.changeSummary(cwd);
    for (const f of git.files) await gitService.revertFile(cwd, f.path).catch(() => undefined);
    return;
  }
  return snapshot.snapshotRevertAll(taskId, cwd);
}
