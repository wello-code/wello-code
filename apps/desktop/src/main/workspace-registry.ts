import { resolve } from "node:path";

/**
 * The set of folders the user has actually opened (this session, or restored from
 * saved state). The renderer supplies a `workspacePath` on every git/file call; on
 * its own that path is untrusted (a compromised renderer could pass any directory),
 * so main only serves paths that appear here. This is defense-in-depth, not the
 * primary guard — `assertInside` still confines each file under its workspace.
 */
const roots = new Set<string>();

function norm(p: string): string {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

/** Remember a folder the user opened (via the picker) or that was restored on load. */
export function registerWorkspace(path: string | null | undefined): void {
  if (path && path.trim()) roots.add(norm(path));
}

/** True only for a folder opened this session or seeded from persisted tasks. */
export function isKnownWorkspace(path: string): boolean {
  return typeof path === "string" && roots.has(norm(path));
}
