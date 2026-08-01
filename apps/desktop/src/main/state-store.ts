import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { PersistedState, StateSavePayload } from "../shared/ipc-api";

/**
 * Durable app state (chats, timelines, last workspace) in userData as JSON.
 * Writes are atomic (tmp + rename) so a crash mid-write never corrupts a file.
 * Chat contents are renderer-owned and opaque to main; `version` gates format.
 *
 * ⚠️ Layout, and why it is not one file (measured 2026-07-29). Everything used to
 * live in a single `wello-state.json` that was read, parsed, deep-copied across
 * IPC and re-serialised in full on every change. On an idle app, with NO turns
 * run, the main process settled at roughly ten times the file:
 *
 *     history on disk   main process
 *     empty             108 MB
 *     16.6 MB           299 MB
 *     49.8 MB           591 MB
 *
 * A user whose archive had grown reported 1292 MB in main two minutes after
 * launch. So the history is stored per chat and only what changed is written:
 *
 *     wello-state.json    the index — version, workspace, active chat, chat ids
 *     chats/<id>.json     one chat, written only when that chat changed
 *     wello-drafts.json   composer drafts, so typing never touches the history
 *
 * The load path NEVER silently discards a file it can't use: an unrecognized
 * version (a newer build wrote it, then the user downgraded) or a parse error
 * is backed up to a sidecar BEFORE we return null, so the next save can't
 * overwrite the only copy of the history. Recoverable by hand or a future migrator.
 */
const CURRENT_VERSION = 2;
/** The single-file format this build still reads (and migrates on the next save). */
const LEGACY_VERSION = 1;

function statePath(): string {
  return join(app.getPath("userData"), "wello-state.json");
}
function chatsDir(): string {
  return join(app.getPath("userData"), "chats");
}
function draftsPath(): string {
  return join(app.getPath("userData"), "wello-drafts.json");
}

/** A chat id becomes a file name, so it may only ever look like an id. */
export function isChatId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(id);
}
function chatPath(id: string): string {
  return join(chatsDir(), `${id}.json`);
}

/** What loadState should do with a raw index file's contents (pure — testable). */
export type StateVerdict =
  | { kind: "empty" } // nothing usable, nothing to preserve
  | { kind: "ok"; state: PersistedState } // legacy single file: tasks included
  | { kind: "index"; workspace: PersistedState["workspace"]; activeId: string | null; taskIds: string[] }
  | { kind: "backup"; reason: "corrupt" | "newer" | "unknown" }; // keep a sidecar, then discard

/**
 * Decide what to do with the on-disk state. NEVER discards silently: a file we
 * can't use (corrupt JSON, a newer version from a since-downgraded build, or an
 * untrusted shape) yields a `backup` verdict so the caller copies it aside first.
 */
export function classifyState(raw: string): StateVerdict {
  let parsed: {
    version?: unknown;
    tasks?: unknown;
    taskIds?: unknown;
    activeId?: unknown;
    workspace?: { path?: unknown } | null;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "backup", reason: "corrupt" };
  }
  if (parsed?.version === CURRENT_VERSION && Array.isArray(parsed.taskIds)) {
    return {
      kind: "index",
      workspace: (parsed.workspace ?? null) as PersistedState["workspace"],
      activeId: typeof parsed.activeId === "string" ? parsed.activeId : null,
      taskIds: parsed.taskIds.filter(isChatId),
    };
  }
  if (parsed?.version === LEGACY_VERSION && Array.isArray(parsed.tasks)) {
    return { kind: "ok", state: parsed as unknown as PersistedState };
  }
  if (typeof parsed?.version === "number" && parsed.version > CURRENT_VERSION) {
    return { kind: "backup", reason: "newer" };
  }
  return { kind: "backup", reason: "unknown" };
}

/** Copy the current state file aside so an unusable one is never lost. */
async function backupState(reason: string): Promise<void> {
  try {
    const src = statePath();
    if (!existsSync(src)) return;
    // One sidecar per reason (overwritten) — not an unbounded pile of backups.
    await copyFile(src, `${src}.${reason}.bak`);
  } catch {
    // Best-effort; a failed backup must not block startup.
  }
}

async function writeJsonAtomic(target: string, json: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  await writeFile(tmp, json, "utf8");
  await rename(tmp, target);
}

async function readDrafts(): Promise<Record<string, string> | null> {
  try {
    const parsed = JSON.parse(await readFile(draftsPath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export async function loadState(): Promise<PersistedState | null> {
  let raw: string;
  try {
    raw = await readFile(statePath(), "utf8");
  } catch {
    return null; // no file yet — a fresh install, nothing to recover
  }
  const verdict = classifyState(raw);
  if (verdict.kind === "backup") {
    await backupState(verdict.reason);
    return null;
  }

  let state: PersistedState;
  if (verdict.kind === "ok") {
    // Legacy single file. Handed back as-is, flagged so the renderer marks every
    // chat as unsaved — the next autosave writes them out per chat.
    state = { ...verdict.state, legacy: true };
  } else if (verdict.kind === "index") {
    // One read per chat, in the index's order. A chat file that is missing or
    // unreadable is skipped rather than failing the whole restore — losing one
    // conversation beats losing the app's entire history.
    const tasks: unknown[] = [];
    for (const id of verdict.taskIds) {
      try {
        tasks.push(JSON.parse(await readFile(chatPath(id), "utf8")));
      } catch {
        /* skip this chat */
      }
    }
    state = {
      version: LEGACY_VERSION,
      workspace: verdict.workspace,
      activeId: verdict.activeId,
      tasks,
    };
  } else {
    return null;
  }

  // Drafts live in their own file now; an older state file may still carry them.
  const drafts = await readDrafts();
  if (drafts) state.drafts = drafts;
  // A workspace that no longer exists on disk must not be restored.
  if (state.workspace && !existsSync(state.workspace.path)) state.workspace = null;
  return state;
}

/**
 * The newest save waiting to be written, and whether a write is in flight.
 *
 * ⚠️ This used to be a promise CHAIN (`writing = writing.then(...)`), which meant
 * every queued save kept its own copy alive until its turn came, and every one of
 * them was written even though only the last matters. Now: at most one queued
 * payload, newest wins, and the superseded one becomes garbage immediately.
 */
let queued: StateSavePayload | null = null;
let flushing = false;
/** Diagnostics only — surfaced in the perf report so a "it eats memory" ticket
 *  carries the numbers instead of a feeling. */
let savesSinceStart = 0;
let lastWriteBytes = 0;

/** How much the last save wrote, and how many saves have run. */
export function saveStats(): { saves: number; bytes: number } {
  return { saves: savesSinceStart, bytes: lastWriteBytes };
}

async function writeSave(payload: StateSavePayload): Promise<void> {
  const ids = payload.taskIds.filter(isChatId);
  let bytes = 0;
  // 1. Chat contents FIRST: if we die before the index is written, the previous
  //    index still points at a complete set of files.
  for (const chat of payload.changed) {
    const id = (chat as { id?: unknown }).id;
    if (!isChatId(id)) continue;
    const json = JSON.stringify(chat);
    bytes += Buffer.byteLength(json);
    await writeJsonAtomic(chatPath(id), json);
  }
  // 2. The index — small, and the only thing that decides what gets restored.
  const index = JSON.stringify({
    version: CURRENT_VERSION,
    workspace: payload.workspace,
    activeId: payload.activeId,
    taskIds: ids,
  });
  bytes += Buffer.byteLength(index);
  await writeJsonAtomic(statePath(), index);
  // 3. Chats the user deleted (and leftovers from a legacy migration): their
  //    files are no longer referenced, so drop them.
  try {
    const keep = new Set(ids);
    for (const name of await readdir(chatsDir())) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (isChatId(id) && !keep.has(id)) await rm(join(chatsDir(), name), { force: true });
    }
  } catch {
    /* nothing to prune */
  }
  savesSinceStart += 1;
  lastWriteBytes = bytes;
}

/** Resolves when nothing is queued or in flight (tests; a shutdown flush later). */
let settled: Promise<void> = Promise.resolve();
export function savesSettled(): Promise<void> {
  return settled;
}

export function saveState(payload: StateSavePayload): void {
  // Newest wins: an older queued payload is dropped, never written.
  queued = payload;
  if (flushing) return;
  flushing = true;
  settled = (async () => {
    try {
      while (queued) {
        const next = queued;
        queued = null;
        try {
          await writeSave(next);
        } catch {
          // Persistence is best-effort; the running session keeps its state.
        }
      }
    } finally {
      flushing = false;
    }
  })();
}

/**
 * Persist ONLY the composer drafts, in their own small file.
 *
 * Typing must not cost the whole history: the autosave's deps include the live
 * prompt, so every pause in typing used to ship (and re-serialise) every chat
 * the user has ever had. A few strings in their own file instead.
 */
export async function saveDrafts(drafts: Record<string, string>): Promise<void> {
  try {
    await writeJsonAtomic(draftsPath(), JSON.stringify(drafts));
  } catch {
    // Best-effort: a lost draft is not worth an error path.
  }
}
