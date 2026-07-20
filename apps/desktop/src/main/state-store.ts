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

let writing = Promise.resolve();

export function saveState(state: PersistedState): void {
  // Serialize writes so a fast sequence of saves cannot interleave tmp files.
  writing = writing.then(async () => {
    try {
      const target = statePath();
      await mkdir(dirname(target), { recursive: true });
      const tmp = target + ".tmp";
      await writeFile(tmp, JSON.stringify(state), "utf8");
      await rename(tmp, target);
    } catch {
      // Persistence is best-effort; the running session keeps its in-memory state.
    }
  });
}
