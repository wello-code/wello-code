import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { splitFrontmatter, type ProjectCommand } from "../shared/slash-template";

/**
 * Scan a workspace's `.claude/commands/**.md` into invokable slash commands.
 * Subfolders become `namespace:command` (Claude Code convention). Bounded and
 * symlink-safe: never follows a link out of the commands dir, caps count/size.
 */
const MAX_COMMANDS = 200;
const MAX_BYTES = 64 * 1024;

/** The command name from a path relative to the commands root: `sub/x.md` → `sub:x`. */
function commandName(rel: string): string {
  return rel
    .replace(/\.md$/i, "")
    .split(/[\\/]/)
    .join(":");
}

export async function scanProjectCommands(workspacePath: string): Promise<ProjectCommand[]> {
  const root = join(workspacePath, ".claude", "commands");
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return []; // no commands dir
  }
  const out: ProjectCommand[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_COMMANDS) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_COMMANDS) return;
      if (e.isSymbolicLink()) continue; // never follow links out of the tree
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        // Defense in depth: confirm the real path stays under the commands root.
        let real: string;
        try {
          real = await realpath(full);
        } catch {
          continue;
        }
        const relToRoot = relative(realRoot, real);
        if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) continue;
        let raw: string;
        try {
          const buf = await readFile(real);
          if (buf.length > MAX_BYTES) continue;
          raw = buf.toString("utf8");
        } catch {
          continue;
        }
        const { fields, body } = splitFrontmatter(raw);
        if (!body.trim()) continue;
        const name = commandName(relative(realRoot, full).split(/[\\/]/).join("/"));
        out.push({
          name,
          description: (fields.description || name).slice(0, 200),
          ...(fields["argument-hint"] ? { argumentHint: fields["argument-hint"].slice(0, 80) } : {}),
          body,
        });
      }
    }
  }
  await walk(realRoot);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
