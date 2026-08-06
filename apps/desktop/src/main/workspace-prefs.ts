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
  /** The agent's own cross-session notes about the project (trusted only). */
  memory: string;
  /**
   * Extra folders the agent may work in besides the project itself — the
   * answer to «я работаю с двумя репозиториями сразу» (reported 2026-08-07).
   * Chosen by the user through the OS folder picker, never by the model.
   */
  extraDirs: string[];
}

/**
 * Ceiling on extra folders per project. Each one widens what the agent can
 * touch and rides the engine's startup, so this is a deliberate handful, not a
 * place to attach a whole drive.
 */
export const MAX_WORKSPACE_EXTRA_DIRS = 8;

/**
 * Ceiling for the agent's project notes. Small on purpose: memory rides the
 * system prompt of EVERY turn in the folder — a note that needs more than this
 * is a session log, not memory, and the tool tells the model to tighten it.
 */
export const WORKSPACE_MEMORY_MAX_CHARS = 8000;

interface PrefsFile {
  version: 1;
  /** Set once the legacy-state grandfather migration ran (see below). */
  migratedAt?: string;
  workspaces: Record<
    string,
    {
      trusted: boolean;
      grantedCaps: string[];
      decidedAt: string;
      memory?: string;
      extraDirs?: string[];
      /**
       * The entry exists only because a folder was attached before the trust
       * question was ever answered — `decided` must stay false, or the app
       * would silently treat the project as "answered: not trusted" and never
       * ask again. Absent on every entry a real decision wrote.
       */
      trustPending?: boolean;
    }
  >;
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
      ...(typeof entry.memory === "string" && entry.memory
        ? { memory: entry.memory.slice(0, WORKSPACE_MEMORY_MAX_CHARS) }
        : {}),
      ...(entry.trustPending === true ? { trustPending: true as const } : {}),
      ...(Array.isArray(entry.extraDirs)
        ? {
            extraDirs: entry.extraDirs
              .filter((d): d is string => typeof d === "string" && d.trim().length > 0)
              .slice(0, MAX_WORKSPACE_EXTRA_DIRS),
          }
        : {}),
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
  if (!entry) {
    return { decided: false, trusted: false, grantedCaps: [], memory: "", extraDirs: [] };
  }
  return {
    decided: entry.trustPending !== true,
    trusted: entry.trusted,
    grantedCaps: [...entry.grantedCaps],
    memory: entry.memory ?? "",
    extraDirs: [...(entry.extraDirs ?? [])],
  };
}

/**
 * Attach another folder to this project. The path comes from the OS picker in
 * privileged code — never from the renderer or the model — so this only has to
 * defend against pointless entries: duplicates, the project itself, and
 * anything already covered by it.
 */
export async function addWorkspaceDir(
  path: string,
  dir: string,
): Promise<{ ok: true; dirs: string[] } | { ok: false; reason: "inside_project" | "duplicate" | "too_many" }> {
  const file = await load();
  const key = workspaceKey(path);
  // A folder the user never trusted/answered for still gets an entry: attaching
  // a second folder is an explicit act and must not silently vanish.
  const entry = (file.workspaces[key] ??= {
    trusted: false,
    grantedCaps: [],
    decidedAt: new Date().toISOString(),
    // Nothing about trust was answered here — see trustPending.
    trustPending: true,
  });
  const dirs = entry.extraDirs ?? [];
  if (isInside(dir, path)) return { ok: false, reason: "inside_project" };
  if (dirs.some((d) => workspaceKey(d) === workspaceKey(dir))) {
    return { ok: false, reason: "duplicate" };
  }
  if (dirs.length >= MAX_WORKSPACE_EXTRA_DIRS) return { ok: false, reason: "too_many" };
  entry.extraDirs = [...dirs, dir];
  persist();
  return { ok: true, dirs: [...entry.extraDirs] };
}

/** Detach a folder from the project (the agent stops seeing it next turn). */
export async function removeWorkspaceDir(path: string, dir: string): Promise<string[]> {
  const file = await load();
  const entry = file.workspaces[workspaceKey(path)];
  if (!entry?.extraDirs) return [];
  entry.extraDirs = entry.extraDirs.filter((d) => workspaceKey(d) !== workspaceKey(dir));
  persist();
  return [...entry.extraDirs];
}

/** Is `dir` the folder `root` itself, or somewhere inside it? */
function isInside(dir: string, root: string): boolean {
  const a = workspaceKey(dir);
  const b = workspaceKey(root);
  return a === b || a.startsWith(`${b}/`);
}

/**
 * Replace the agent's project notes. Whole-text semantics on purpose: the model
 * reads the current notes from its system prompt and writes the tightened full
 * version back — that keeps the notes self-compacting instead of append-only.
 * Untrusted folders never store memory (same rule as every project input).
 */
export async function setWorkspaceMemory(
  path: string,
  memory: string,
): Promise<{ ok: true } | { ok: false; reason: "untrusted" | "too_long" }> {
  const file = await load();
  const entry = file.workspaces[workspaceKey(path)];
  if (!entry || !entry.trusted) return { ok: false, reason: "untrusted" };
  if (memory.length > WORKSPACE_MEMORY_MAX_CHARS) return { ok: false, reason: "too_long" };
  const trimmed = memory.trim();
  if (trimmed) entry.memory = trimmed;
  else delete entry.memory;
  persist();
  return { ok: true };
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
    // Attached folders are the user's own choice about WHERE they work, not a
    // trust decision — a trust toggle must not quietly detach them.
    ...(prev?.extraDirs?.length ? { extraDirs: [...prev.extraDirs] } : {}),
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
