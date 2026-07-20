import { existsSync } from "node:fs";
import { join } from "node:path";

export interface PreviewRoot {
  root: string;
  entry: string;
}

/** Where a built static site's index.html tends to live, most-specific first. */
const CANDIDATE_DIRS = ["dist", "build", "out", "public", "."];

/**
 * Find the directory holding the workspace's built `index.html` (dist/build/out/
 * public/root), or null if there's nothing to preview. Candidates are hard-coded
 * (no user path input), and the workspace itself is already isKnownWorkspace-gated
 * at the IPC layer, so no traversal guard is needed here.
 */
export function resolvePreviewRoot(workspacePath: string): PreviewRoot | null {
  for (const c of CANDIDATE_DIRS) {
    const root = c === "." ? workspacePath : join(workspacePath, c);
    if (existsSync(join(root, "index.html"))) return { root, entry: "index.html" };
  }
  return null;
}
