import { createHash } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { app } from "electron";
import type { ChangedFile, ChangeSummary } from "../shared/ipc-api";
import { lineDiff } from "./line-diff";

/**
 * Git-less change review: a per-task, content-addressed snapshot of the workspace
 * taken before the task's first run, used to diff and revert what the agent changed
 * in a plain (non-git) folder. Full-tree snapshot — NOT tool-path tracking — so
 * mutations via Bash / MCP servers are caught too, and revert has real base bytes.
 */

const SNAPSHOT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 4000;

/** Directories never snapshotted (noise / huge / build output) — mirrors the picker. */
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "out", "build", ".next", ".nuxt",
  ".cache", ".turbo", "coverage", "target", "vendor", "__pycache__", ".venv", "venv",
  ".idea", ".gradle", "bin", "obj",
]);

interface SnapshotFileMeta {
  hash: string;
  size: number;
  mtimeMs: number;
  binary: boolean;
}
interface SnapshotManifest {
  version: 1;
  createdAt: string;
  root: string;
  partial: boolean;
  files: Record<string, SnapshotFileMeta>;
}

/** Reject a hostile task id before it becomes a path segment (traversal guard). */
export function sanitizeTaskId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid task id.");
  return id;
}

function snapshotsRoot(): string {
  return join(app.getPath("userData"), "review-snapshots");
}
function taskDir(taskId: string): string {
  return join(snapshotsRoot(), sanitizeTaskId(taskId));
}
function objectPath(taskId: string, hash: string): string {
  return join(taskDir(taskId), "objects", hash);
}

/** Reject any path that escapes the workspace (same contract as git/workspace-files). */
function assertInside(cwd: string, file: string): string {
  const abs = resolve(cwd, file);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path escapes the workspace.");
  }
  return abs;
}

/** Real path of `abs`, only if it stays inside `cwd` after following symlinks (else null). */
async function realInside(cwd: string, abs: string): Promise<string | null> {
  try {
    const [realTarget, realCwd] = await Promise.all([realpath(abs), realpath(cwd)]);
    const rel = relative(realCwd, realTarget);
    return rel !== "" && (rel.startsWith("..") || isAbsolute(rel)) ? null : realTarget;
  } catch {
    return abs;
  }
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

/** Eligible relative file paths under `cwd` (skips IGNORE_DIRS + symlinks, capped). */
async function walk(cwd: string): Promise<string[]> {
  const realCwd = await realpath(cwd).catch(() => cwd);
  const out: string[] = [];
  async function rec(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.isSymbolicLink()) continue; // never follow links out of the tree
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await rec(full);
      } else if (e.isFile()) {
        out.push(relative(realCwd, full).split(sep).join("/"));
      }
    }
  }
  await rec(realCwd);
  return out;
}

async function loadManifest(taskId: string): Promise<SnapshotManifest | null> {
  try {
    return JSON.parse(await readFile(join(taskDir(taskId), "manifest.json"), "utf8")) as SnapshotManifest;
  } catch {
    return null;
  }
}

async function writeManifest(taskId: string, manifest: SnapshotManifest): Promise<void> {
  const target = join(taskDir(taskId), "manifest.json");
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest), "utf8");
  await rename(tmp, target);
}

/**
 * Capture the pre-run baseline for a task (idempotent — no-op once a manifest
 * exists). Best-effort: caller awaits this BEFORE the agent's first write so edits
 * don't leak into the base. Caps trip `partial`, not a throw.
 */
export async function ensureBaseline(taskId: string, cwd: string): Promise<void> {
  sanitizeTaskId(taskId);
  if (await loadManifest(taskId)) return;
  const files: Record<string, SnapshotFileMeta> = {};
  let total = 0;
  let partial = false;
  const rels = await walk(cwd);
  if (rels.length >= MAX_FILES) partial = true;
  await mkdir(join(taskDir(taskId), "objects"), { recursive: true });
  for (const rel of rels) {
    const real = await realInside(cwd, assertInside(cwd, rel));
    if (!real) continue;
    let info;
    try {
      info = await stat(real);
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    if (info.size > SNAPSHOT_MAX_FILE_BYTES || total + info.size > SNAPSHOT_MAX_TOTAL_BYTES) {
      partial = true;
      continue;
    }
    const buf = await readFile(real).catch(() => null);
    if (!buf) continue;
    const hash = createHash("sha256").update(buf).digest("hex");
    const obj = objectPath(taskId, hash);
    if (!(await stat(obj).catch(() => null))) {
      const tmp = `${obj}.tmp`;
      await writeFile(tmp, buf);
      await rename(tmp, obj);
    }
    files[rel] = { hash, size: info.size, mtimeMs: info.mtimeMs, binary: isBinary(buf) };
    total += info.size;
  }
  await writeManifest(taskId, {
    version: 1,
    createdAt: new Date().toISOString(),
    root: cwd,
    partial,
    files,
  });
}

interface Change {
  rel: string;
  status: "added" | "modified" | "deleted";
}

/** Files that differ from the baseline (fast size+mtime skip, hash to confirm). */
async function changedFiles(cwd: string, manifest: SnapshotManifest): Promise<Change[]> {
  const current = await walk(cwd);
  const currentSet = new Set(current);
  const changes: Change[] = [];
  // Deleted: in base, gone now.
  for (const rel of Object.keys(manifest.files)) {
    if (!currentSet.has(rel)) changes.push({ rel, status: "deleted" });
  }
  for (const rel of current) {
    const base = manifest.files[rel];
    const real = await realInside(cwd, assertInside(cwd, rel));
    if (!real) continue;
    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (!base) {
      changes.push({ rel, status: "added" });
      continue;
    }
    // Unchanged fast-path: same size AND mtime → skip the hash.
    if (info.size === base.size && info.mtimeMs === base.mtimeMs) continue;
    const buf = await readFile(real).catch(() => null);
    if (!buf) continue;
    const hash = createHash("sha256").update(buf).digest("hex");
    if (hash !== base.hash) changes.push({ rel, status: "modified" });
  }
  return changes;
}

async function baseText(taskId: string, meta: SnapshotFileMeta): Promise<string | null> {
  if (meta.binary) return null;
  const buf = await readFile(objectPath(taskId, meta.hash)).catch(() => null);
  return buf ? buf.toString("utf8") : null;
}
async function currentText(cwd: string, rel: string): Promise<string | null> {
  const real = await realInside(cwd, assertInside(cwd, rel));
  if (!real) return null;
  const buf = await readFile(real).catch(() => null);
  if (!buf || isBinary(buf)) return null;
  return buf.toString("utf8");
}

/** Change summary for the review pane (per-file +/- counts). */
export async function snapshotSummary(taskId: string, cwd: string): Promise<ChangeSummary> {
  const manifest = await loadManifest(taskId);
  if (!manifest) return { isRepo: false, backing: "none", files: [], additions: 0, deletions: 0 };
  const changes = await changedFiles(cwd, manifest);
  const files: ChangedFile[] = [];
  for (const c of changes) {
    const base = manifest.files[c.rel];
    const bt = base ? await baseText(taskId, base) : "";
    const ct = c.status === "deleted" ? "" : await currentText(cwd, c.rel);
    // Binary (or unreadable) either side → no textual counts.
    const counts = bt == null || ct == null ? { additions: 0, deletions: 0 } : lineDiff(bt, ct);
    files.push({ path: c.rel, status: c.status, additions: counts.additions, deletions: counts.deletions });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    isRepo: false,
    backing: "snapshot",
    files,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

/** Unified diff of one file vs its baseline (untracked = the file is newly added). */
export async function snapshotDiff(
  taskId: string,
  cwd: string,
  rel: string,
): Promise<{ diff: string; untracked: boolean }> {
  const manifest = await loadManifest(taskId);
  const base = manifest?.files[rel];
  const bt = base ? await baseText(taskId, base) : "";
  const ct = await currentText(cwd, rel);
  const untracked = !base;
  if (bt == null || ct == null) {
    return { diff: `Двоичный файл — дифф не показывается.`, untracked };
  }
  return { diff: lineDiff(bt, ct).diff, untracked };
}

/** Restore one file to its baseline bytes (added file → delete it). */
export async function snapshotRevertFile(taskId: string, cwd: string, rel: string): Promise<void> {
  const manifest = await loadManifest(taskId);
  if (!manifest) return;
  const abs = assertInside(cwd, rel);
  const base = manifest.files[rel];
  if (!base) {
    // Added since baseline — remove it (guard the delete target too).
    const real = await realInside(cwd, abs);
    if (real) await rm(real, { force: true });
    return;
  }
  const buf = await readFile(objectPath(taskId, base.hash)).catch(() => null);
  if (!buf) return;
  // Confine the WRITE: realInside on the parent dir so a symlinked path can't land
  // bytes outside the workspace; create parent dirs only inside the tree.
  const parent = dirname(abs);
  const realParent = await realInside(cwd, parent);
  if (!realParent && (await stat(parent).catch(() => null))) return; // parent escapes — refuse
  await mkdir(parent, { recursive: true });
  const tmp = `${abs}.wello-tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, abs);
}

/** Revert every changed file to the baseline (the «Отменить весь ход» action). */
export async function snapshotRevertAll(taskId: string, cwd: string): Promise<void> {
  const manifest = await loadManifest(taskId);
  if (!manifest) return;
  const changes = await changedFiles(cwd, manifest);
  for (const c of changes) {
    await snapshotRevertFile(taskId, cwd, c.rel).catch(() => undefined);
  }
}

/* ── Per-turn checkpoints (rewind: restore code + conversation to a turn) ────── */

/** Reject a hostile checkpoint label before it becomes a filename. */
function sanitizeCheckpointId(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid checkpoint id.");
  return id;
}
function checkpointPath(taskId: string, turnId: string): string {
  return join(taskDir(taskId), "checkpoints", `${sanitizeCheckpointId(turnId)}.json`);
}

/** Snapshot the whole tree into the objects store as a labelled checkpoint. Taken
 *  BEFORE a turn runs, so restoring it returns the project to its pre-turn state.
 *  Reuses the shared, deduped object store — unchanged files add no bytes. */
export async function captureCheckpoint(taskId: string, turnId: string, cwd: string): Promise<void> {
  sanitizeTaskId(taskId);
  sanitizeCheckpointId(turnId);
  const files: Record<string, SnapshotFileMeta> = {};
  let total = 0;
  let partial = false;
  const rels = await walk(cwd);
  if (rels.length >= MAX_FILES) partial = true;
  await mkdir(join(taskDir(taskId), "objects"), { recursive: true });
  for (const rel of rels) {
    const real = await realInside(cwd, assertInside(cwd, rel));
    if (!real) continue;
    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (info.size > SNAPSHOT_MAX_FILE_BYTES || total + info.size > SNAPSHOT_MAX_TOTAL_BYTES) {
      partial = true;
      continue;
    }
    const buf = await readFile(real).catch(() => null);
    if (!buf) continue;
    const hash = createHash("sha256").update(buf).digest("hex");
    const obj = objectPath(taskId, hash);
    if (!(await stat(obj).catch(() => null))) {
      const tmp = `${obj}.tmp`;
      await writeFile(tmp, buf);
      await rename(tmp, obj);
    }
    files[rel] = { hash, size: info.size, mtimeMs: info.mtimeMs, binary: isBinary(buf) };
    total += info.size;
  }
  const target = checkpointPath(taskId, turnId);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ version: 1, createdAt: new Date().toISOString(), root: cwd, partial, files }),
    "utf8",
  );
  await rename(tmp, target);
}

/** Whether a checkpoint exists for this turn (gates the «Откатить сюда» button). */
export async function hasCheckpoint(taskId: string, turnId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId) || !/^[A-Za-z0-9_-]+$/.test(turnId)) return false;
  return Boolean(await stat(checkpointPath(taskId, turnId)).catch(() => null));
}

/**
 * Restore the workspace to a checkpoint: rewrite every file it recorded to those
 * bytes, and delete files created since (present now, absent in the checkpoint).
 * Deletes are confined to the walk set (never touches IGNORE_DIRS / links). This
 * is destructive by design — the caller confirms with the user first.
 */
export async function restoreCheckpoint(taskId: string, turnId: string, cwd: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId) || !/^[A-Za-z0-9_-]+$/.test(turnId)) return false;
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(await readFile(checkpointPath(taskId, turnId), "utf8")) as SnapshotManifest;
  } catch {
    return false;
  }
  // Delete files that appeared after the checkpoint (in the tracked tree only).
  // SKIP the delete phase entirely for a PARTIAL checkpoint: a file skipped at
  // capture (over 2MB, or past the 128MB total) is absent from the manifest yet
  // present on disk, so deleting "unknown" files would wipe the user's own large
  // assets that the snapshot never stored. Restoring recorded files is still safe.
  if (!manifest.partial) {
    const now = await walk(cwd);
    for (const rel of now) {
      if (manifest.files[rel]) continue;
      const real = await realInside(cwd, assertInside(cwd, rel));
      if (real) await rm(real, { force: true }).catch(() => undefined);
    }
  }
  // Rewrite every checkpointed file to its recorded bytes (guarded write path).
  for (const [rel, meta] of Object.entries(manifest.files)) {
    const buf = await readFile(objectPath(taskId, meta.hash)).catch(() => null);
    if (!buf) continue;
    const abs = assertInside(cwd, rel);
    const parent = dirname(abs);
    const realParent = await realInside(cwd, parent);
    if (!realParent && (await stat(parent).catch(() => null))) continue; // parent escapes — refuse
    await mkdir(parent, { recursive: true }).catch(() => undefined);
    const tmp = `${abs}.wello-tmp`;
    await writeFile(tmp, buf).catch(() => undefined);
    await rename(tmp, abs).catch(() => undefined);
  }
  return true;
}

/** Delete a task's snapshot dir (on task delete). */
export async function forget(taskId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return;
  await rm(taskDir(taskId), { recursive: true, force: true }).catch(() => undefined);
}

/** Remove snapshot dirs for tasks that no longer exist (orphan sweep). */
export async function gc(knownTaskIds: string[]): Promise<void> {
  const keep = new Set(knownTaskIds.filter((id) => /^[A-Za-z0-9_-]+$/.test(id)));
  const dirs = await readdir(snapshotsRoot(), { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (d.isDirectory() && !keep.has(d.name)) {
      await rm(join(snapshotsRoot(), d.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
