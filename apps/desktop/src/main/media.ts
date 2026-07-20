import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { PathStat } from "../shared/ipc-api";

/**
 * Media helpers for the composer/chat: image previews (the renderer's CSP allows
 * `img-src data:` only, so local files reach it as data: URLs) and stat() for the
 * Claude-style attachment size limits. Both operate on paths the user explicitly
 * attached (picker, drop, paste) — reads are gated to image extensions and capped.
 */

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Display-only ceiling; the attach-time limit (10 MB, as Claude) is enforced in the renderer. */
const MAX_PREVIEW_BYTES = 30 * 1024 * 1024;

/** Image bytes as a data: URL for chat previews. Null for non-images/missing/oversized. */
export async function readImageData(path: string): Promise<string | null> {
  const mime = IMAGE_MIME[extname(path).toLowerCase()];
  if (!mime) return null;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0 || info.size > MAX_PREVIEW_BYTES) return null;
    const buf = await readFile(path);
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** stat() for picked paths — attachment limit checks. Missing paths are omitted. */
export async function statPaths(paths: string[]): Promise<PathStat[]> {
  const out: PathStat[] = [];
  for (const path of paths.slice(0, 100)) {
    try {
      const info = await stat(path);
      out.push({ path, size: info.size, isDirectory: info.isDirectory() });
    } catch {
      // Unreadable/missing — the renderer treats absence as "don't attach".
    }
  }
  return out;
}
