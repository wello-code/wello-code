import { open, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

/**
 * Content-addressed blob store for snapshots and checkpoints — PACKED.
 *
 * ⚠️ Why packs, and not one file per hash (measured on Windows 11, 3000 files of
 * ~14 KB, 2026-08-01):
 *
 *     read + hash the whole tree            0.4 s
 *     store it as 3000 files (tmp+rename)  11.9 s     ← the "first turn hangs" report
 *     store it as 3000 files (plain write)  9.9 s
 *     store it as ONE appended pack         0.06 s
 *     re-check 3000 blobs with stat()       0.6 s     ← paid on EVERY turn
 *     list the store with one readdir       0.004 s
 *
 * Creating a file on NTFS (with a virus scanner in the path) costs milliseconds;
 * appending to an open one costs microseconds. A checkpoint is taken before every
 * turn, so the old layout charged the user a stat storm per turn and a ten-second
 * freeze the first time they opened a project.
 *
 * Layout under `<root>`:
 *     packs/<id>.pack    blobs, appended, never rewritten in place
 *     packs/<id>.idx     "<sha256> <offset> <length>" per line, appended with them
 *     objects/<sha256>   loose blobs written by builds before this one (read-only)
 *
 * The index is read once per session (one read per pack) and answers "do we have
 * these bytes" from memory. It is trusted because this process is the store's
 * only writer — the app takes a single-instance lock — and a pack whose file is
 * shorter than the index claims has its tail entries dropped on load, so a
 * truncated or hand-deleted store degrades to "re-read the file", never to a
 * silent wrong restore.
 */

/** Roll to a new pack past this size, so gc can drop whole files. */
const PACK_MAX_BYTES = 512 * 1024 * 1024;
/** Rewrite the store only when this much of it is dead weight. */
const SWEEP_MIN_DEAD_BYTES = 32 * 1024 * 1024;
/** Bytes held in memory while copying blobs around (gc, legacy adoption). */
const BATCH_BYTES = 16 * 1024 * 1024;

interface Located {
  pack: string;
  offset: number;
  len: number;
}

let root = "";
/** hash → where its bytes are. Null until the packs have been read. */
let index: Map<string, Located> | null = null;
/** Loose blobs from an older build, by hash (kept readable, never added to). */
let loose: Set<string> | null = null;
/** The pack currently being appended to, and its size in bytes. */
let head: { id: string; bytes: number } | null = null;
/** Open pack handles, reused across reads; closed before gc deletes anything. */
const handles = new Map<string, FileHandle>();
/** Serialises appends: two chats can start a turn at the same moment. */
let writeChain: Promise<unknown> = Promise.resolve();

/** Point the store at `<userData>/review-snapshots` (and forget any cached state). */
export function configureObjectStore(dir: string): void {
  root = dir;
  index = null;
  loose = null;
  head = null;
  void closeHandles();
}

function packsDir(): string {
  return join(root, "packs");
}
function packPath(id: string): string {
  return join(packsDir(), `${id}.pack`);
}
function idxPath(id: string): string {
  return join(packsDir(), `${id}.idx`);
}
function looseDir(): string {
  return join(root, "objects");
}
/** Where a pre-shared-store build kept a task's own blobs (still read, never
 *  written). Null for anything that isn't an id — it becomes a path segment. */
function taskLoosePath(taskId: string, hash: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return null;
  return join(root, taskId, "objects", hash);
}

/** A hash out of a manifest becomes a file name / index key — only ever a digest. */
export function isHash(hash: string): boolean {
  return /^[0-9a-f]{64}$/.test(hash);
}

async function closeHandles(): Promise<void> {
  const open = [...handles.values()];
  handles.clear();
  await Promise.all(open.map((h) => h.close().catch(() => undefined)));
}

/** Read every pack index once. Entries past the pack's real length are dropped. */
async function ensureIndex(): Promise<Map<string, Located>> {
  if (index) return index;
  const map = new Map<string, Located>();
  const names = await readdir(packsDir()).catch(() => [] as string[]);
  let newest: { id: string; bytes: number } | null = null;
  for (const name of names) {
    if (!name.endsWith(".idx")) continue;
    const id = name.slice(0, -4);
    const size = (await stat(packPath(id)).catch(() => null))?.size ?? 0;
    if (size === 0) continue;
    const raw = await readFile(idxPath(id), "utf8").catch(() => "");
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const [hash, offset, len] = line.split(" ");
      if (!hash || !isHash(hash) || !offset || !len) continue;
      const at = Number(offset);
      const bytes = Number(len);
      // A partial append (killed mid-write) leaves index lines pointing past the
      // end of the pack. Those bytes are not there; pretend we never had them.
      if (!Number.isFinite(at) || !Number.isFinite(bytes) || at + bytes > size) continue;
      map.set(hash, { pack: id, offset: at, len: bytes });
    }
    if (!newest || id > newest.id) newest = { id, bytes: size };
  }
  if (newest && newest.bytes < PACK_MAX_BYTES) head = newest;
  index = map;
  return map;
}

/** Loose blobs left by an older build, listed with one readdir instead of N stats. */
async function ensureLoose(): Promise<Set<string>> {
  if (loose) return loose;
  const names = await readdir(looseDir()).catch(() => [] as string[]);
  loose = new Set(names.filter(isHash));
  return loose;
}

/** True when these bytes are already stored (no filesystem round trip per hash). */
export async function haveObject(hash: string, taskId?: string): Promise<boolean> {
  if (!isHash(hash)) return false;
  if ((await ensureIndex()).has(hash)) return true;
  if ((await ensureLoose()).has(hash)) return true;
  const legacy = taskId ? taskLoosePath(taskId, hash) : null;
  if (!legacy) return false;
  return Boolean(await stat(legacy).catch(() => null));
}

async function packHandle(id: string): Promise<FileHandle | null> {
  const cached = handles.get(id);
  if (cached) return cached;
  const fh = await open(packPath(id), "r").catch(() => null);
  if (fh) handles.set(id, fh);
  return fh;
}

/** The stored bytes for a hash, from a pack or from either legacy location. */
export async function readObject(hash: string, taskId?: string): Promise<Buffer | null> {
  if (!isHash(hash)) return null;
  const at = (await ensureIndex()).get(hash);
  if (at) {
    const fh = await packHandle(at.pack);
    if (fh) {
      const buf = Buffer.allocUnsafe(at.len);
      const { bytesRead } = await fh.read(buf, 0, at.len, at.offset).catch(() => ({ bytesRead: -1 }));
      if (bytesRead === at.len) return buf;
    }
  }
  const fromLoose = await readFile(join(looseDir(), hash)).catch(() => null);
  if (fromLoose) return fromLoose;
  const legacy = taskId ? taskLoosePath(taskId, hash) : null;
  if (!legacy) return null;
  return readFile(legacy).catch(() => null);
}

/**
 * Append blobs we don't have yet — ONE write to the pack and one to its index,
 * however many files the caller brings. Unknown-hash entries are ignored.
 */
export async function storeObjects(entries: { hash: string; buf: Buffer }[]): Promise<void> {
  if (entries.length === 0) return;
  const run = writeChain.then(() => appendObjects(entries));
  // Keep the chain alive even if this batch fails: storing is best-effort, and a
  // rejected link would poison every later append.
  writeChain = run.catch(() => undefined);
  await run;
}

/**
 * Append a batch to the head pack. `skipKnown` is off only for the gc rewrite,
 * which copies blobs the index still lists (into the pack that replaces them).
 */
async function appendObjects(
  entries: { hash: string; buf: Buffer }[],
  skipKnown = true,
): Promise<void> {
  const map = await ensureIndex();
  const known = await ensureLoose();
  const fresh: { hash: string; buf: Buffer }[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (!isHash(e.hash) || seen.has(e.hash)) continue;
    if (skipKnown && (map.has(e.hash) || known.has(e.hash))) continue;
    seen.add(e.hash);
    fresh.push(e);
  }
  if (fresh.length === 0) return;
  await mkdir(packsDir(), { recursive: true });
  if (!head || head.bytes >= PACK_MAX_BYTES) {
    head = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, bytes: 0 };
  }
  const id = head.id;
  // Offsets are assigned from the size we believe the pack has; the append itself
  // is what makes them true, so a failed write must not leave them in the index.
  let offset = head.bytes;
  const lines: string[] = [];
  const located: [string, Located][] = [];
  for (const e of fresh) {
    lines.push(`${e.hash} ${offset} ${e.buf.length}`);
    located.push([e.hash, { pack: id, offset, len: e.buf.length }]);
    offset += e.buf.length;
  }
  const fh = await open(packPath(id), "a");
  try {
    await fh.writeFile(Buffer.concat(fresh.map((e) => e.buf)));
  } finally {
    await fh.close().catch(() => undefined);
  }
  // Index AFTER the bytes: a crash between the two costs a re-read, never a
  // pointer into nothing (and the loader re-checks the length anyway).
  const idx = await open(idxPath(id), "a");
  try {
    await idx.writeFile(`${lines.join("\n")}\n`);
  } finally {
    await idx.close().catch(() => undefined);
  }
  head = { id, bytes: offset };
  for (const [hash, at] of located) map.set(hash, at);
}

/** Bytes currently held in packs (diagnostics + the sweep's own accounting). */
async function packSizes(): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (const name of await readdir(packsDir()).catch(() => [] as string[])) {
    if (!name.endsWith(".pack")) continue;
    const id = name.slice(0, -5);
    sizes.set(id, (await stat(packPath(id)).catch(() => null))?.size ?? 0);
  }
  return sizes;
}

/**
 * Drop everything `live` doesn't name: loose blobs go straight away, packs are
 * rewritten into a fresh one only when enough of them is dead — copying a live
 * store to save a few megabytes would cost more than it frees.
 *
 * Called at startup, when no capture can be running.
 */
export async function sweepObjects(live: Set<string>): Promise<void> {
  const map = await ensureIndex();
  const known = await ensureLoose();
  for (const hash of known) {
    if (live.has(hash)) continue;
    await rm(join(looseDir(), hash), { force: true }).catch(() => undefined);
    known.delete(hash);
  }
  const sizes = await packSizes();
  let total = 0;
  for (const bytes of sizes.values()) total += bytes;
  let liveBytes = 0;
  for (const [hash, at] of map) if (live.has(hash)) liveBytes += at.len;
  const dead = total - liveBytes;
  // Worth a rewrite when the dead weight is large in absolute terms, or when
  // most of the store is dead (a user who deleted their chats gets the disk back).
  if (dead < SWEEP_MIN_DEAD_BYTES && dead * 2 <= total) return;

  // Rewrite: copy the survivors into a NEW pack (the old ones are still there and
  // still readable), then drop the old files. Bounded batches — a 128 MB store
  // must not become 128 MB of heap.
  const doomed = [...sizes.keys()];
  head = null; // force a fresh pack; nothing appends into a file we're about to delete
  const carry = new Batcher((batch) => appendObjects(batch, false));
  for (const hash of map.keys()) {
    if (!live.has(hash)) continue;
    const buf = await readObject(hash);
    if (buf) await carry.add(hash, buf);
  }
  await carry.flush();
  await closeHandles();
  for (const id of doomed) {
    await rm(packPath(id), { force: true }).catch(() => undefined);
    await rm(idxPath(id), { force: true }).catch(() => undefined);
  }
  // The surviving bytes are in the new pack; re-read the layout from disk rather
  // than trusting a map that still names deleted files.
  index = null;
  head = null;
  await ensureIndex();
}

/** Collects blobs and appends them a batch at a time, bounding peak memory. */
class Batcher {
  private batch: { hash: string; buf: Buffer }[] = [];
  private bytes = 0;

  constructor(
    private readonly write: (batch: { hash: string; buf: Buffer }[]) => Promise<void> = (batch) =>
      appendObjects(batch),
  ) {}

  async add(hash: string, buf: Buffer): Promise<void> {
    this.batch.push({ hash, buf });
    this.bytes += buf.length;
    if (this.bytes >= BATCH_BYTES) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.batch.length === 0) return;
    const batch = this.batch;
    this.batch = [];
    this.bytes = 0;
    await this.write(batch);
  }
}

/**
 * Take a pre-shared-store task's own blob folder into the pack store (upgrade
 * path). Same bytes, one file instead of thousands, and duplicates collapse onto
 * the hash that is already there.
 */
export async function adoptTaskObjects(taskId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return;
  const dir = join(root, taskId, "objects");
  const names = await readdir(dir).catch(() => null);
  if (!names) return; // nothing legacy here
  const carry = new Batcher();
  for (const name of names) {
    if (!isHash(name)) continue; // stray tmp file — dropped with the folder below
    const buf = await readFile(join(dir, name)).catch(() => null);
    if (buf) await carry.add(name, buf);
  }
  await carry.flush();
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

/** How many bytes the packs hold (the perf report and the sweep's accounting). */
export async function storeBytes(): Promise<number> {
  let total = 0;
  for (const bytes of (await packSizes()).values()) total += bytes;
  return total;
}
