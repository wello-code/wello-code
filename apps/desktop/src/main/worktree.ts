import { promises as fs } from "node:fs";
import { basename, join } from "node:path";
import { branchInfo, worktreeAdd, worktreeRemove } from "./git";

/**
 * Task worktrees: «Новая задача в копии проекта». The copy is a linked git
 * worktree under the app's own data dir, on a fresh `wello/…` branch — the
 * agent works there without touching the main checkout, and the result is an
 * ordinary branch of the same repo (merge it with the normal branch tools).
 */

/** Where a project's task copies live (given userData). */
export function worktreesRoot(userData: string): string {
  return join(userData, "worktrees");
}

/** Filesystem-safe stem from the project folder name (Cyrillic survives). */
export function worktreeStem(originPath: string, now = new Date()): string {
  const name = basename(originPath).replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 40) || "project";
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "").replace(/-/g, "");
  return `${name}-${stamp}`;
}

/** The branch a task copy works on. Latin-only: branch names travel to remotes. */
export function worktreeBranch(stem: string): string {
  const latin = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
  return `wello/${latin}`;
}

export interface WorktreeCreated {
  ok: true;
  path: string;
  branch: string;
}
export interface WorktreeFailed {
  ok: false;
  /** Honest RU reason the toast can show verbatim. */
  error: string;
}

/**
 * Create the copy. Refuses politely when the folder is not a usable git repo
 * (no repo / unborn HEAD) — the UI only offers the toggle for repos, this is
 * the backstop.
 */
export async function createTaskWorktree(
  originPath: string,
  userData: string,
  now = new Date(),
): Promise<WorktreeCreated | WorktreeFailed> {
  const info = await branchInfo(originPath);
  if (info.gitMissing) return { ok: false, error: "Git не установлен." };
  if (!info.isRepo) return { ok: false, error: "Папка не является git-репозиторием." };
  if (info.unborn) {
    return { ok: false, error: "В репозитории ещё нет коммитов — сначала сделайте первый коммит." };
  }
  const stem = worktreeStem(originPath, now);
  const dir = join(worktreesRoot(userData), stem);
  const branch = worktreeBranch(stem);
  await fs.mkdir(worktreesRoot(userData), { recursive: true });
  const res = await worktreeAdd(originPath, dir, branch);
  if (!res.ok) {
    return { ok: false, error: res.stderr || "Не удалось создать копию проекта." };
  }
  return { ok: true, path: dir, branch };
}

/**
 * Remove the copy when its task is deleted. Never forces — dirty copies stay
 * on disk (deleting a chat must not delete unsaved code) and the caller tells
 * the user where the folder remained.
 */
export async function removeTaskWorktree(
  originPath: string,
  worktreePath: string,
): Promise<{ ok: boolean; dirty?: boolean }> {
  const res = await worktreeRemove(originPath, worktreePath);
  return { ok: res.ok, ...(res.dirty ? { dirty: true } : {}) };
}
