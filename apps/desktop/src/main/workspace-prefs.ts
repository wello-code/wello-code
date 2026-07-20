import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";

/**
 * Per-workspace preferences: the user's trust decision and the persisted
 * "allow always in this project" permission grants. Main-process only —
 * the renderer talks through narrow IPC verbs and never writes the file.
 *
 * Trust gates everything project-supplied: untrusted folders run with
 * `settingSources: []` (no CLAUDE.md / .claude settings / hooks from the repo),
 * without persisted grants, and only in asking permission modes.
 */
export interface WorkspacePrefs {
  /** Whether the user has answered the trust question for this folder at all. */
  decided: boolean;
  trusted: boolean;
  /** Capabilities granted with «Разрешить для проекта» (only honored when trusted). */
  grantedCaps: string[];
}

interface PrefsFile {
  version: 1;
  /** Set once the legacy-state grandfather migration ran (see below). */
  migratedAt?: string;
  workspaces: Record<string, { trusted: boolean; grantedCaps: string[]; decidedAt: string }>;
}

/** Case/separator-insensitive key so `C:\Foo` and `c:/foo/` land on one entry. */
export function workspaceKey(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function prefsPath(): string {
  return join(app.getPath("userData"), "wello-workspaces.json");
}

let cache: PrefsFile | null = null;
// Concurrent first loads must share ONE read: without this, several callers in
// the same tick (state.load fans out per restored workspace) would each read the
// file and each overwrite `cache` with their own object — mutations applied to
// the losing objects would silently vanish.
let loading: Promise<PrefsFile> | null = null;

async function load(): Promise<PrefsFile> {
  if (cache) return cache;
  loading ??= (async () => {
    try {
      const raw = await readFile(prefsPath(), "utf8");
      const parsed = JSON.parse(raw) as PrefsFile;
      cache = {
        version: 1,
        ...(typeof parsed?.migratedAt === "string" ? { migratedAt: parsed.migratedAt } : {}),
        workspaces:
          parsed && typeof parsed.workspaces === "object" && parsed.workspaces
            ? sanitize(parsed.workspaces)
            : {},
      };
    } catch {
      cache = { version: 1, workspaces: {} };
    }
    return cache;
  })();
  return loading;
}

function sanitize(raw: PrefsFile["workspaces"]): PrefsFile["workspaces"] {
  const out: PrefsFile["workspaces"] = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    out[key] = {
      trusted: entry.trusted === true,
      grantedCaps: Array.isArray(entry.grantedCaps)
        ? entry.grantedCaps.filter((c): c is string => typeof c === "string")
        : [],
      decidedAt: typeof entry.decidedAt === "string" ? entry.decidedAt : new Date().toISOString(),
    };
  }
  return out;
}

let writing = Promise.resolve();

function persist(): void {
  const snapshot = cache;
  if (!snapshot) return;
  const body = JSON.stringify(snapshot, null, 2);
  writing = writing.then(async () => {
    try {
      const target = prefsPath();
      await mkdir(dirname(target), { recursive: true });
      const tmp = target + ".tmp";
      await writeFile(tmp, body, "utf8");
      await rename(tmp, target);
    } catch {
      // Best-effort persistence.
    }
  });
}

export async function getWorkspacePrefs(path: string): Promise<WorkspacePrefs> {
  const file = await load();
  const entry = file.workspaces[workspaceKey(path)];
  if (!entry) return { decided: false, trusted: false, grantedCaps: [] };
  return { decided: true, trusted: entry.trusted, grantedCaps: [...entry.grantedCaps] };
}

/** Record the user's trust decision. Revoking trust also revokes every grant. */
export async function setWorkspaceTrust(path: string, trusted: boolean): Promise<void> {
  const file = await load();
  const key = workspaceKey(path);
  const prev = file.workspaces[key];
  file.workspaces[key] = {
    trusted,
    grantedCaps: trusted ? (prev?.grantedCaps ?? []) : [],
    decidedAt: new Date().toISOString(),
  };
  persist();
}

/**
 * ONE-TIME migration: workspaces restored from a pre-trust build's state are
 * marked trusted (they already ran the agent without a gate; re-asking would
 * read as a regression). Runs exactly once per install — `migratedAt` in the
 * prefs file seals it, so a folder where the user merely DEFERRED the trust
 * question (dismissed the modal) can never become trusted by a mere restart.
 */
export async function grandfatherLegacyWorkspaces(paths: string[]): Promise<void> {
  const file = await load();
  if (file.migratedAt) return;
  file.migratedAt = new Date().toISOString();
  for (const path of paths) {
    const key = workspaceKey(path);
    if (file.workspaces[key]) continue;
    file.workspaces[key] = { trusted: true, grantedCaps: [], decidedAt: file.migratedAt };
  }
  persist();
}

/** Persist an «Разрешить для проекта» grant (no-op for untrusted folders). */
export async function addWorkspaceGrant(path: string, capability: string): Promise<void> {
  const file = await load();
  const entry = file.workspaces[workspaceKey(path)];
  if (!entry || !entry.trusted) return;
  if (!entry.grantedCaps.includes(capability)) {
    entry.grantedCaps.push(capability);
    persist();
  }
}

/** Drop every persisted grant for the folder (the «Сбросить разрешения» action). */
export async function clearWorkspaceGrants(path: string): Promise<void> {
  const file = await load();
  const entry = file.workspaces[workspaceKey(path)];
  if (entry && entry.grantedCaps.length > 0) {
    entry.grantedCaps = [];
    persist();
  }
}

/** Test-only: drop the in-memory cache so the next call re-reads the disk. */
export function resetWorkspacePrefsForTests(): void {
  cache = null;
  loading = null;
}
