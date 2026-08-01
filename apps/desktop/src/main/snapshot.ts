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
import type { ChangedFile, ChangeSummary } from "../shared/ipc-api";
import { lineDiff } from "./line-diff";
import {
  adoptTaskObjects,
  configureObjectStore,
  haveObject,
  readObject,
  storeObjects,
  sweepObjects,
} from "./object-store";

/**
 * Git-less change review: a per-task, content-addressed snapshot of the workspace
 * taken before the task's first run, used to diff and revert what the agent changed
 * in a plain (non-git) folder. Full-tree snapshot — NOT tool-path tracking — so
 * mutations via Bash / MCP servers are caught too, and revert has real base bytes.
 */

const SNAPSHOT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const MAX_FILES = 4000;
/** Filesystem round trips in flight. Metadata is cheap and latency-bound, reads
 *  are not — going wide on both is what turns a minute of scanning into seconds. */
const STAT_CONCURRENCY = 32;
const READ_CONCURRENCY = 12;
/** How many bytes of file contents may be in memory before they are stored. */
const STORE_BATCH_BYTES = 16 * 1024 * 1024;

/** Directories never snapshotted (noise / huge / build output) — mirrors the picker. */
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "out", "build", ".next", ".nuxt",
  ".cache", ".turbo", "coverage", "target", "vendor", "__pycache__", ".venv", "venv",
  ".idea", ".gradle", "bin", "obj",
]);

export interface SnapshotFileMeta {
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

/**
 * Where snapshots live. Set once at startup (and by the tests) instead of read
 * from `app.getPath` — this module runs in a worker thread, where the Electron
 * API does not exist.
 */
let snapshotsDir = "";

/** Point the snapshot store at `<userData>/review-snapshots`. */
export function configureSnapshots(userDataDir: string): void {
  snapshotsDir = join(userDataDir, "review-snapshots");
  configureObjectStore(snapshotsDir);
  lastScan.clear();
}

function snapshotsRoot(): string {
  // Refuse rather than resolve against the working directory: an unconfigured
  // store would quietly scatter packs and manifests wherever the app was started.
  if (!snapshotsDir) throw new Error("Snapshot store is not configured.");
  return snapshotsDir;
}
function taskDir(taskId: string): string {
  return join(snapshotsRoot(), sanitizeTaskId(taskId));
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

/** Split `items` into runs whose declared sizes stay under `limit` bytes. */
function chunkByBytes<T extends { size: number }>(items: T[], limit: number): T[][] {
  const out: T[][] = [];
  let run: T[] = [];
  let bytes = 0;
  for (const item of items) {
    if (run.length > 0 && bytes + item.size > limit) {
      out.push(run);
      run = [];
      bytes = 0;
    }
    run.push(item);
    bytes += item.size;
  }
  if (run.length > 0) out.push(run);
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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

/* ── The tree scan, reused between turns ─────────────────────────────────────
   A checkpoint is taken before EVERY turn, and the naive version read and
   hashed the whole project each time: on a 1000-file / 56 MB repo that is ~1.8s
   of main-process work per turn (plus 56 MB of disk reads), which is exactly
   when the window has a stream to forward and IPC to answer. Between two turns
   almost nothing changed, so we keep the last scan and re-use the recorded hash
   of every file whose size AND mtime still match — the same staleness contract
   `changedFiles` already relies on. Measured on that repo: 1.8 s → 0.3 s, and
   nothing is read from disk at all. */

/** The hint is per FOLDER, not per task: a new chat on the same project sees the
 *  same tree, and starting one should not cost a full re-read. */
function scanHintPath(cwd: string): string {
  const key = createHash("sha256").update(cwd.toLowerCase()).digest("hex").slice(0, 32);
  return join(snapshotsRoot(), "scans", `${key}.json`);
}
/** folder → its last scan, so a checkpoint mid-session skips even that read. */
const lastScan = new Map<string, Record<string, SnapshotFileMeta>>();

async function loadLastScan(cwd: string): Promise<Record<string, SnapshotFileMeta> | null> {
  const cached = lastScan.get(cwd);
  if (cached) return cached;
  try {
    const raw = JSON.parse(await readFile(scanHintPath(cwd), "utf8")) as {
      files?: Record<string, SnapshotFileMeta>;
    };
    if (!raw.files) return null;
    lastScan.set(cwd, raw.files);
    return raw.files;
  } catch {
    return null; // no hint yet (or unreadable) — the next scan is simply a full one
  }
}

async function rememberScan(cwd: string, files: Record<string, SnapshotFileMeta>): Promise<void> {
  lastScan.set(cwd, files);
  const target = scanHintPath(cwd);
  try {
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify({ version: 1, files }), "utf8");
    await rename(tmp, target);
  } catch {
    // Best-effort: without the hint the next scan just costs a full read.
  }
}

/** One pass over the tree: every eligible file's hash, plus whether caps cut it short. */
export interface Scan {
  files: Record<string, SnapshotFileMeta>;
  partial: boolean;
}

/**
 * Hash the whole tree into the shared object store.
 *
 * `previous` is the folder's last scan: a file whose size and mtime are
 * unchanged keeps its recorded hash (one stat, no read), as long as the blob is
 * still in the store. Everything else is read, hashed and stored as before.
 * Caps trip `partial` rather than throwing.
 */
async function scanTree(
  taskId: string,
  cwd: string,
  previous: Record<string, SnapshotFileMeta> | null,
): Promise<Scan> {
  const files: Record<string, SnapshotFileMeta> = {};
  let partial = false;
  const rels = await walk(cwd);
  if (rels.length >= MAX_FILES) partial = true;

  // 1. Stat everything in parallel — thousands of round trips one after another
  //    is what made a scan take tens of seconds on a real project.
  //
  //    ⚠️ Deliberately NO realpath per file. `walk` skips every symlink and
  //    junction (a reparse point is a link to libuv), so nothing it returns can
  //    reach outside the tree, and the paths are ours, not the user's — the `..`
  //    guard below is what makes that true. Resolving each one anyway cost a
  //    second syscall per file: 0.47 s on a 3000-file project, EVERY turn.
  //    The write paths (revert, restore) still resolve, and must: they take
  //    paths from a manifest and put bytes on disk.
  const stats = await mapLimit(rels, STAT_CONCURRENCY, async (rel) => {
    let real: string;
    try {
      real = assertInside(cwd, rel);
    } catch {
      return null; // path escapes the workspace — not ours to record
    }
    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) return null;
    return { rel, real, size: info.size, mtimeMs: info.mtimeMs };
  });

  // 2. Apply the caps in walk order, so which files a partial snapshot keeps
  //    stays deterministic, and split "already known" from "must be read".
  const toRead: { rel: string; real: string; size: number; mtimeMs: number }[] = [];
  let total = 0;
  for (const entry of stats) {
    if (!entry) continue;
    if (entry.size > SNAPSHOT_MAX_FILE_BYTES || total + entry.size > SNAPSHOT_MAX_TOTAL_BYTES) {
      partial = true;
      continue;
    }
    total += entry.size;
    const before = previous?.[entry.rel];
    if (before && before.size === entry.size && before.mtimeMs === entry.mtimeMs) {
      files[entry.rel] = before;
      continue;
    }
    toRead.push(entry);
  }

  // 3. A re-used hash is only good while its blob is still in the store. The
  //    store answers from its in-memory index, so this is a map lookup per file
  //    rather than the stat storm it used to be (0.6 s per turn on 3000 files).
  const reused = Object.entries(files);
  const present = await mapLimit(reused, STAT_CONCURRENCY, ([, meta]) =>
    haveObject(meta.hash, taskId),
  );
  reused.forEach(([rel, meta], i) => {
    if (!present[i]) {
      delete files[rel];
      toRead.push({ rel, real: resolve(cwd, rel), size: meta.size, mtimeMs: meta.mtimeMs });
    }
  });

  // 4. Read + hash + store only what actually changed, in chunks: the bytes are
  //    held in memory until the batch is appended, and a 128 MB tree must not
  //    become 128 MB of heap.
  for (const chunk of chunkByBytes(toRead, STORE_BATCH_BYTES)) {
    const read = await mapLimit(chunk, READ_CONCURRENCY, async (entry) => {
      const buf = await readFile(entry.real).catch(() => null);
      if (!buf) return null;
      const hash = createHash("sha256").update(buf).digest("hex");
      return {
        rel: entry.rel,
        buf,
        meta: { hash, size: entry.size, mtimeMs: entry.mtimeMs, binary: isBinary(buf) },
      };
    });
    const batch = read.filter((r): r is NonNullable<typeof r> => r !== null);
    await storeObjects(batch.map((r) => ({ hash: r.meta.hash, buf: r.buf })));
    for (const r of batch) files[r.rel] = r.meta;
  }
  return { files, partial };
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
 *
 * Returns the scan it took, or null when there was nothing to do — `prepareTurn`
 * hands it straight to the checkpoint instead of walking the tree twice.
 */
export async function ensureBaseline(taskId: string, cwd: string): Promise<Scan | null> {
  sanitizeTaskId(taskId);
  if (await loadManifest(taskId)) return null;
  const scan = await scanTree(taskId, cwd, await loadLastScan(cwd));
  await writeManifest(taskId, {
    version: 1,
    createdAt: new Date().toISOString(),
    root: cwd,
    partial: scan.partial,
    files: scan.files,
  });
  await rememberScan(cwd, scan.files);
  return scan;
}

/**
 * Everything that must happen BEFORE a turn runs, in one call and one tree scan.
 *
 * `dirtyPaths` is git's list of already-uncommitted files, or null for a plain
 * folder (which gets the full snapshot baseline instead). Previously main made
 * three separate calls here and the first turn of a task scanned the project
 * twice; the scan is the expensive part, so it is taken once and reused.
 */
export async function prepareTurn(
  taskId: string,
  turnId: string,
  cwd: string,
  dirtyPaths: string[] | null,
): Promise<void> {
  sanitizeTaskId(taskId);
  sanitizeCheckpointId(turnId);
  let scan: Scan | null = null;
  if (dirtyPaths === null) {
    scan = await ensureBaseline(taskId, cwd).catch(() => null);
  } else {
    await ensureGitBaseline(taskId, cwd, dirtyPaths).catch(() => undefined);
  }
  if (!scan) scan = await scanTree(taskId, cwd, await loadLastScan(cwd));
  await writeCheckpoint(taskId, turnId, cwd, scan);
}

/* ── Git baseline: what was ALREADY dirty when the task started ──────────────
   In a git repo the review pane reads `git status`, which knows nothing about
   tasks: it shows every uncommitted change in the folder. So a user who opened
   a project with unsaved work saw it attributed to a run that had not even
   happened ("изменено 13 файлов" after a 402), and «Отменить» offered to throw
   THEIR work away. We record the already-dirty files at task start — content
   included, in the same deduped object store — so the review can subtract them
   and revert can put them back byte-for-byte instead of resetting to HEAD. */

const GIT_BASELINE_FILE = "git-baseline.json";
/** Cap the pre-existing dirt we store: a huge uncommitted tree is not worth GBs. */
const GIT_BASELINE_MAX_FILES = 500;

export interface GitBaseline {
  version: 1;
  createdAt: string;
  root: string;
  /** Only the files git reported as dirty at task start. */
  files: Record<string, SnapshotFileMeta>;
}

function gitBaselinePath(taskId: string): string {
  return join(taskDir(taskId), GIT_BASELINE_FILE);
}

/**
 * Capture the already-dirty files of a git workspace for this task (idempotent —
 * the first run of a task wins, later runs keep the original baseline so the
 * review keeps showing everything the task has done, not just its last turn).
 * Best-effort: a failure only degrades to the old, unfiltered behaviour.
 */
export async function ensureGitBaseline(
  taskId: string,
  cwd: string,
  dirtyPaths: string[],
): Promise<void> {
  sanitizeTaskId(taskId);
  if (await loadGitBaseline(taskId)) return;
  const files: Record<string, SnapshotFileMeta> = {};
  let total = 0;
  let blobs: { hash: string; buf: Buffer }[] = [];
  let held = 0;
  for (const rel of dirtyPaths.slice(0, GIT_BASELINE_MAX_FILES)) {
    let real: string | null;
    try {
      real = await realInside(cwd, assertInside(cwd, rel));
    } catch {
      continue; // path escapes the workspace — not ours to record
    }
    if (!real) continue;
    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (info.size > SNAPSHOT_MAX_FILE_BYTES || total + info.size > SNAPSHOT_MAX_TOTAL_BYTES) continue;
    const buf = await readFile(real).catch(() => null);
    if (!buf) continue;
    const hash = createHash("sha256").update(buf).digest("hex");
    blobs.push({ hash, buf });
    held += buf.length;
    files[rel] = { hash, size: info.size, mtimeMs: info.mtimeMs, binary: isBinary(buf) };
    total += info.size;
    if (held >= STORE_BATCH_BYTES) {
      await storeObjects(blobs);
      blobs = [];
      held = 0;
    }
  }
  await storeObjects(blobs);
  const target = gitBaselinePath(taskId);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ version: 1, createdAt: new Date().toISOString(), root: cwd, files } satisfies GitBaseline),
    "utf8",
  );
  await rename(tmp, target);
}

export async function loadGitBaseline(taskId: string): Promise<GitBaseline | null> {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return null;
  try {
    return JSON.parse(await readFile(gitBaselinePath(taskId), "utf8")) as GitBaseline;
  } catch {
    return null;
  }
}

/** True when `rel` still holds exactly the bytes it had at task start. */
export async function matchesGitBaseline(
  cwd: string,
  rel: string,
  meta: SnapshotFileMeta,
): Promise<boolean> {
  let real: string | null;
  try {
    real = await realInside(cwd, assertInside(cwd, rel));
  } catch {
    return false;
  }
  if (!real) return false;
  const info = await stat(real).catch(() => null);
  if (!info || !info.isFile()) return false;
  if (info.size !== meta.size) return false;
  if (info.mtimeMs === meta.mtimeMs) return true; // untouched — skip the hash
  const buf = await readFile(real).catch(() => null);
  if (!buf) return false;
  return createHash("sha256").update(buf).digest("hex") === meta.hash;
}

/**
 * Restore a file to the bytes it had when the task started (NOT to HEAD): the
 * file was already modified by the user before the agent touched it, so a git
 * checkout would silently delete work the agent never made.
 */
export async function restoreGitBaselineFile(taskId: string, cwd: string, rel: string): Promise<boolean> {
  const base = await loadGitBaseline(taskId);
  const meta = base?.files[rel];
  if (!meta) return false;
  const buf = await readObject(meta.hash, taskId);
  if (!buf) return false;
  const abs = assertInside(cwd, rel);
  const parent = dirname(abs);
  const realParent = await realInside(cwd, parent);
  if (!realParent && (await stat(parent).catch(() => null))) return false; // parent escapes — refuse
  await mkdir(parent, { recursive: true });
  const tmp = `${abs}.wello-tmp`;
  await writeFile(tmp, buf);
  await rename(tmp, abs);
  return true;
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
  // Runs after every turn, over the whole tree: stat wide, then hash only the
  // few files whose size or mtime moved. No realpath per file, for the reason
  // spelled out in `scanTree`.
  type Verdict =
    | { kind: "added"; rel: string }
    | { kind: "suspect"; rel: string; real: string; base: SnapshotFileMeta };
  const verdicts = await mapLimit<string, Verdict | null>(current, STAT_CONCURRENCY, async (rel) => {
    const base = manifest.files[rel];
    let real: string;
    try {
      real = assertInside(cwd, rel);
    } catch {
      return null;
    }
    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) return null;
    if (!base) return { kind: "added", rel };
    // Unchanged fast-path: same size AND mtime → skip the hash.
    if (info.size === base.size && info.mtimeMs === base.mtimeMs) return null;
    return { kind: "suspect", rel, real, base };
  });
  const suspects = verdicts.filter((v): v is Extract<Verdict, { kind: "suspect" }> => v?.kind === "suspect");
  for (const v of verdicts) if (v?.kind === "added") changes.push({ rel: v.rel, status: "added" });
  const confirmed = await mapLimit(suspects, READ_CONCURRENCY, async (s) => {
    const buf = await readFile(s.real).catch(() => null);
    if (!buf) return null;
    return createHash("sha256").update(buf).digest("hex") === s.base.hash ? null : s.rel;
  });
  for (const rel of confirmed) if (rel) changes.push({ rel, status: "modified" });
  return changes;
}

async function baseText(taskId: string, meta: SnapshotFileMeta): Promise<string | null> {
  if (meta.binary) return null;
  const buf = await readObject(meta.hash, taskId);
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
  const buf = await readObject(base.hash, taskId);
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
  await writeCheckpoint(taskId, turnId, cwd, await scanTree(taskId, cwd, await loadLastScan(cwd)));
}

/** Persist a scan as this turn's checkpoint, and keep it as the folder's hint. */
async function writeCheckpoint(
  taskId: string,
  turnId: string,
  cwd: string,
  { files, partial }: Scan,
): Promise<void> {
  const target = checkpointPath(taskId, turnId);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ version: 1, createdAt: new Date().toISOString(), root: cwd, partial, files }),
    "utf8",
  );
  await rename(tmp, target);
  await rememberScan(cwd, files);
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
    const buf = await readObject(meta.hash, taskId);
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

/** Every blob hash a task's manifests still point at. */
async function referencedHashes(taskId: string): Promise<Set<string> | null> {
  const found = new Set<string>();
  const collect = async (file: string): Promise<boolean> => {
    const raw = await readFile(file, "utf8").catch(() => null);
    if (raw === null) return true; // absent is fine — nothing to reference
    try {
      const parsed = JSON.parse(raw) as { files?: Record<string, { hash?: unknown }> };
      for (const meta of Object.values(parsed.files ?? {})) {
        if (typeof meta?.hash === "string") found.add(meta.hash);
      }
      return true;
    } catch {
      return false; // unreadable manifest — do NOT let the sweep guess
    }
  };
  const dir = taskDir(taskId);
  if (!(await collect(join(dir, "manifest.json")))) return null;
  if (!(await collect(join(dir, GIT_BASELINE_FILE)))) return null;
  const cps = await readdir(join(dir, "checkpoints")).catch(() => [] as string[]);
  for (const name of cps) {
    if (!name.endsWith(".json")) continue;
    if (!(await collect(join(dir, "checkpoints", name)))) return null;
  }
  return found;
}

/**
 * Remove snapshot dirs for tasks that no longer exist, then drop shared blobs
 * nothing references anymore (mark and sweep). Called at startup, when no run
 * can be writing — a blob stored by a checkpoint whose manifest is not on disk
 * yet would otherwise look unreferenced. Any manifest we fail to parse cancels
 * the sweep: keeping dead bytes is cheap, deleting live ones breaks rewind.
 */
export async function gc(knownTaskIds: string[]): Promise<void> {
  const keep = new Set(knownTaskIds.filter((id) => /^[A-Za-z0-9_-]+$/.test(id)));
  const dirs = await readdir(snapshotsRoot(), { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    // Shared, not a task: the pack store, the loose blobs an older build wrote,
    // and the per-folder scan hints.
    if (d.name === "objects" || d.name === "scans" || d.name === "packs") continue;
    if (!keep.has(d.name)) {
      await rm(join(snapshotsRoot(), d.name), { recursive: true, force: true }).catch(() => undefined);
    } else {
      await adoptTaskObjects(d.name);
    }
  }
  const live = new Set<string>();
  for (const id of keep) {
    const hashes = await referencedHashes(id);
    if (!hashes) return; // a manifest we could not read — leave every blob alone
    for (const h of hashes) live.add(h);
  }
  await sweepObjects(live);
}
