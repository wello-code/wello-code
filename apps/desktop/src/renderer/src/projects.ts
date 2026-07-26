/**
 * Projects — the folder a chat belongs to, as a first-class thing in the UI.
 *
 * Every chat is already bound to a workspace folder; the sidebar just never said
 * so, and a person working on three repos got one flat list where a chat about
 * a landing page sits between two about a backend. Antigravity and Codex both
 * solve this by making the project the top-level axis, and that is what this
 * adds: pick a project, see its chats, start new ones in it.
 *
 * Nothing new is persisted. A project IS a folder that chats point at, so the
 * list is derived from the chats themselves plus the folder that is open right
 * now — no registry to fall out of sync, no migration, and deleting the last
 * chat of a project simply removes it from the list.
 */

export interface ProjectChat {
  workspacePath: string | null;
  workspaceName?: string | null;
}

export interface Project {
  /** Absolute folder path — the identity of a project. */
  path: string;
  /** Folder name for display. */
  name: string;
  /** How many chats live in it. */
  count: number;
  /** Most recent activity among its chats (sort key). */
  lastActivityMs: number;
}

/** Path comparison that matches how the OS treats it (Windows is case-blind). */
function samePath(a: string, b: string): boolean {
  return typeof navigator !== "undefined" && /win/i.test(navigator.platform)
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/** Last path segment, for display: "C:\dev\shop" → "shop". */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/**
 * The projects to offer, newest activity first. `current` is the folder picked
 * for the NEXT new chat — it belongs in the list even with no chats yet, or the
 * user would pick a folder and watch it not appear.
 */
export function deriveProjects<T extends ProjectChat>(
  chats: T[],
  activityMs: (chat: T) => number,
  current?: { path: string; name?: string | null } | null,
): Project[] {
  const byPath = new Map<string, Project>();
  const add = (path: string, name: string | null | undefined, at: number): void => {
    const existing = byPath.get(path);
    if (existing) {
      existing.count += 1;
      existing.lastActivityMs = Math.max(existing.lastActivityMs, at);
      return;
    }
    byPath.set(path, {
      path,
      name: (name ?? "").trim() || folderName(path),
      count: 1,
      lastActivityMs: at,
    });
  };
  for (const c of chats) {
    if (!c.workspacePath) continue;
    add(c.workspacePath, c.workspaceName, activityMs(c));
  }
  if (current?.path) {
    const existing = [...byPath.values()].find((p) => samePath(p.path, current.path));
    if (!existing) {
      byPath.set(current.path, {
        path: current.path,
        name: (current.name ?? "").trim() || folderName(current.path),
        count: 0,
        // A freshly picked folder sorts to the top: it is what the user is doing.
        lastActivityMs: Number.MAX_SAFE_INTEGER,
      });
    }
  }
  return [...byPath.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

/**
 * Chats of one project. `null` means "all projects" (the flat list we had).
 * Chats with no folder yet stay visible in every view — they are unfinished
 * drafts, and hiding them behind a project they don't have would lose them.
 */
export function filterByProject<T extends ProjectChat>(chats: T[], path: string | null): T[] {
  if (!path) return chats;
  return chats.filter((c) => !c.workspacePath || samePath(c.workspacePath, path));
}

/** Whether `path` still exists among the projects (a deleted project falls back to "all"). */
export function projectExists(projects: Project[], path: string | null): boolean {
  return path == null || projects.some((p) => samePath(p.path, path));
}
