import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { shell } from "electron";
import type { WorkspaceFile } from "../shared/ipc-api";

/** Reject any path that escapes the workspace (same contract as the git module). */
function assertInside(cwd: string, file: string): string {
  const abs = resolve(cwd, file);
  const rel = relative(cwd, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path escapes the workspace.");
  }
  return abs;
}

/**
 * Like `assertInside`, but also follows symlinks: a link that lives inside the
 * workspace yet points outside (e.g. `notes.txt -> C:\Users\me\.ssh\id_rsa`) would
 * pass the string check, so we realpath both sides and re-compare. Returns the real
 * target to read/open. Falls back to the string path when the target does not exist
 * yet (nothing to follow — the sync guard already vetted it).
 */
async function assertInsideReal(cwd: string, file: string): Promise<string> {
  const abs = assertInside(cwd, file);
  let realTarget: string;
  let realCwd: string;
  try {
    [realTarget, realCwd] = await Promise.all([realpath(abs), realpath(cwd)]);
  } catch {
    return abs; // missing file / cwd — no link to follow; let the caller's stat fail.
  }
  const rel = relative(realCwd, realTarget);
  if (rel !== "" && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error("Path escapes the workspace (symlink).");
  }
  return realTarget;
}

const MAX_BYTES = 1_500_000;

/** Directories never worth listing for @-mention (noise / huge / build output). */
const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "out", "build", ".next", ".nuxt",
  ".cache", ".turbo", "coverage", "target", "vendor", "__pycache__", ".venv", "venv",
  ".idea", ".gradle", "bin", "obj",
]);
/** Cap the roster so a giant monorepo can't stall the picker. */
const MAX_LIST_FILES = 4000;

/**
 * Workspace files as `/`-separated relative paths, for the composer's @-mention
 * picker. Walks the tree skipping IGNORE_DIRS and symlinks (never followed —
 * defense-in-depth), capped at MAX_LIST_FILES. Best-effort: unreadable dirs are
 * skipped silently.
 */
export async function listWorkspaceFiles(cwd: string): Promise<string[]> {
  const realCwd = await realpath(cwd).catch(() => cwd);
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_LIST_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_LIST_FILES) return;
      if (e.isSymbolicLink()) continue; // don't follow links out of the tree
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name)) continue;
        await walk(full);
      } else if (e.isFile()) {
        out.push(relative(realCwd, full).split(sep).join("/"));
      }
    }
  }
  await walk(realCwd);
  return out;
}

/** Read a workspace file for the inspector's file view (size- and binary-guarded). */
export async function readWorkspaceFile(cwd: string, file: string): Promise<WorkspaceFile> {
  let abs: string;
  try {
    abs = await assertInsideReal(cwd, file);
  } catch {
    return { ok: false, reason: "missing" };
  }
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { ok: false, reason: "missing" };
    if (info.size > MAX_BYTES) return { ok: false, reason: "too_large" };
    const buf = await readFile(abs);
    // A NUL byte early in the file is a reliable binary signal.
    if (buf.subarray(0, 8192).includes(0)) return { ok: false, reason: "binary" };
    return { ok: true, content: buf.toString("utf8") };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

/**
 * Extensions the OS would EXECUTE (not display) via the default handler. Opening a
 * booby-trapped one from an untrusted repo would run code, so we reveal it in the
 * file manager instead of launching it. Ordinary code/doc/image files open normally.
 */
const UNSAFE_TO_OPEN = new Set([
  ".exe", ".com", ".bat", ".cmd", ".msi", ".msp", ".scr", ".pif", ".cpl", ".dll",
  ".vbs", ".vbe", ".ps1", ".psm1", ".wsf", ".wsh", ".hta", ".reg", ".lnk", ".jar",
  ".app", ".command", ".sh",
]);

/**
 * Project-instruction files the agent honors in a TRUSTED workspace. CLAUDE.md
 * is loaded by the engine itself (settingSources: project — probed live
 * 2026-07-18); AGENTS.md the engine ignores, so we read it ourselves and append
 * it to the system prompt. CLAUDE.md wins when both exist (engine semantics).
 */
const INSTRUCTION_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

/** Cap for a self-injected AGENTS.md — instructions, not a novel. */
const MAX_INSTRUCTIONS_CHARS = 32_000;

/** Which instruction file the workspace carries (null = none). */
export async function instructionsInfo(cwd: string): Promise<{ file: string | null }> {
  for (const name of INSTRUCTION_FILES) {
    try {
      const info = await stat(join(cwd, name));
      if (info.isFile()) return { file: name };
    } catch {
      // keep looking
    }
  }
  return { file: null };
}

/**
 * Instructions the RUNTIME must inject itself: AGENTS.md content when it is the
 * workspace's only instruction file. Null when CLAUDE.md exists (the engine
 * loads it natively) or when there is nothing to load.
 */
export async function readSelfInjectedInstructions(
  cwd: string,
): Promise<{ file: string; content: string } | null> {
  const info = await instructionsInfo(cwd);
  if (info.file !== "AGENTS.md") return null;
  try {
    const buf = await readFile(join(cwd, "AGENTS.md"));
    if (buf.subarray(0, 8192).includes(0)) return null; // binary imposter
    let content = buf.toString("utf8").trim();
    if (!content) return null;
    if (content.length > MAX_INSTRUCTIONS_CHARS) {
      content = `${content.slice(0, MAX_INSTRUCTIONS_CHARS)}\n…(файл обрезан)`;
    }
    return { file: "AGENTS.md", content };
  } catch {
    return null;
  }
}

/** Open a workspace file with the OS default app (revealing, not running, executables). */
export async function openWorkspaceFile(cwd: string, file: string): Promise<void> {
  let abs: string;
  try {
    abs = await assertInsideReal(cwd, file);
  } catch {
    return;
  }
  if (UNSAFE_TO_OPEN.has(extname(abs).toLowerCase())) {
    shell.showItemInFolder(abs);
    return;
  }
  await shell.openPath(abs);
}
