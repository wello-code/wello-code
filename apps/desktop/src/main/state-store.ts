import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { PersistedState } from "../shared/ipc-api";

/**
 * Durable app state (tasks, timelines, last workspace) in userData as JSON.
 * Writes are atomic (tmp + rename) so a crash mid-write never corrupts the file.
 * Task snapshots are renderer-owned and opaque to main; `version` gates format.
 *
 * The load path NEVER silently discards a file it can't use: an unrecognized
 * version (a newer build wrote it, then the user downgraded) or a parse error
 * is backed up to a sidecar BEFORE we return null, so the next save can't
 * overwrite the only copy of the history. Recoverable by hand or a future migrator.
 */
const CURRENT_VERSION = 1;

function statePath(): string {
  return join(app.getPath("userData"), "wello-state.json");
}

/** What loadState should do with a raw file's contents (pure — testable). */
export type StateVerdict =
  | { kind: "empty" } // nothing usable, nothing to preserve
  | { kind: "ok"; state: PersistedState }
  | { kind: "backup"; reason: "corrupt" | "newer" | "unknown" }; // keep a sidecar, then discard

/**
 * Decide what to do with the on-disk state. NEVER discards silently: a file we
 * can't use (corrupt JSON, a newer version from a since-downgraded build, or an
 * untrusted shape) yields a `backup` verdict so the caller copies it aside first.
 * A future format bump adds a migration branch here instead of dropping data.
 */
export function classifyState(raw: string): StateVerdict {
  let parsed: { version?: unknown; tasks?: unknown; workspace?: { path?: unknown } | null };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "backup", reason: "corrupt" };
  }
  if (parsed?.version === CURRENT_VERSION && Array.isArray(parsed.tasks)) {
    return { kind: "ok", state: parsed as unknown as PersistedState };
  }
  if (typeof parsed?.version === "number" && parsed.version > CURRENT_VERSION) {
    return { kind: "backup", reason: "newer" };
  }
  // An older known version would migrate here; none exist yet (v1 is the first).
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

export async function loadState(): Promise<PersistedState | null> {
  let raw: string;
  try {
    raw = await readFile(statePath(), "utf8");
  } catch {
    return null; // no file yet — a fresh install, nothing to recover
  }
  const verdict = classifyState(raw);
  if (verdict.kind === "ok") {
    const state = verdict.state;
    // A workspace that no longer exists on disk must not be restored.
    if (state.workspace && !existsSync(state.workspace.path)) state.workspace = null;
    return state;
  }
  if (verdict.kind === "backup") await backupState(verdict.reason);
  return null;
}

/**
 * The newest state waiting to be written, and whether a write is in flight.
 *
 * ⚠️ This used to be a promise CHAIN (`writing = writing.then(...)`), which meant
 * every queued save kept its own full copy of the state alive until its turn came
 * — and every copy is the ENTIRE history of every chat, freshly deep-copied by
 * the IPC boundary. Saves arrive far faster than a disk write completes (see the
 * autosave in App.tsx), so a heavy user could hold several tens of MB of
 * superseded snapshots at once and serialise all of them in a row, when only the
 * last one is worth writing. Now: at most one queued state, newest wins, and the
 * superseded copy becomes garbage immediately.
 */
let queued: PersistedState | null = null;
let flushing = false;
/** The state being written right now. Part of the merge base for a drafts-only
 *  save: without it, drafts arriving DURING a write would merge into the older
 *  `lastWritten` and push the in-flight turn back out of the file. */
let inFlight: PersistedState | null = null;
/** The last state actually written — the merge base for a drafts-only save. */
let lastWritten: PersistedState | null = null;
/** Diagnostics only — surfaced in the perf report so a "it eats memory" ticket
 *  carries the numbers instead of a feeling. */
let savesSinceStart = 0;
let lastStateBytes = 0;

async function writeStateFile(state: PersistedState): Promise<void> {
  const target = statePath();
  await mkdir(dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  const json = JSON.stringify(state);
  lastStateBytes = Buffer.byteLength(json);
  savesSinceStart += 1;
  await writeFile(tmp, json, "utf8");
  await rename(tmp, target);
  lastWritten = state;
}

/** How much the last save wrote, and how many saves have run. */
export function saveStats(): { saves: number; bytes: number } {
  return { saves: savesSinceStart, bytes: lastStateBytes };
}

export function saveState(state: PersistedState): void {
  // Newest wins: an older queued snapshot is dropped, never written.
  queued = state;
  if (flushing) return;
  flushing = true;
  void (async () => {
    try {
      while (queued) {
        const next = queued;
        queued = null;
        inFlight = next;
        try {
          await writeStateFile(next);
        } catch {
          // Persistence is best-effort; the running session keeps its state.
        } finally {
          inFlight = null;
        }
      }
    } finally {
      flushing = false;
    }
  })();
}

/**
 * Persist ONLY the composer drafts, merged into the last state we wrote.
 *
 * Typing must not cost the whole history: the autosave's deps include the live
 * prompt, so every pause in typing used to ship (and re-serialise) every chat
 * the user has ever had. Drafts are a handful of strings — they take this path
 * instead, and the heavy save stays for changes that actually touch the tasks.
 */
export async function saveDrafts(drafts: Record<string, string>): Promise<void> {
  // Newest known tasks first: queued > being written > last written > disk.
  const base = queued ?? inFlight ?? lastWritten ?? (await loadState().catch(() => null));
  if (!base) return; // nothing to merge into yet; the next full save carries them
  saveState({ ...base, drafts });
}
