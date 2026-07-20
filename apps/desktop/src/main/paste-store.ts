import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";

/**
 * Clipboard images pasted into the composer land here as real files: the model
 * opens them with its Read tool (which renders images), so all a prompt needs is
 * the absolute path. The folder is app-owned and outside any workspace — it never
 * pollutes the project's git status.
 */

const ALLOWED: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
// Mirrors Claude's per-image cap (claude.ai / API: 10 MB) — and the renderer's limit.
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function pastesDir(): string {
  return join(app.getPath("userData"), "pastes");
}

/** Write one pasted image to disk. Returns its absolute path, or null when rejected. */
export async function savePastedImage(data: ArrayBuffer, mime: string): Promise<string | null> {
  const ext = ALLOWED[mime];
  if (!ext || data.byteLength === 0 || data.byteLength > MAX_BYTES) return null;
  const dir = pastesDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `paste-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);
  await writeFile(path, Buffer.from(data));
  return path;
}

/**
 * Write an already-decoded image buffer (e.g. a preview screenshot) to the pastes
 * dir with a distinguishing prefix. Same app-owned folder as pasted images, so the
 * agent can Read it without a permission card (pastesDir is whitelisted).
 */
export async function saveImageBuffer(buffer: Buffer, ext: string, prefix: string): Promise<string> {
  const dir = pastesDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${prefix}-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);
  await writeFile(path, buffer);
  return path;
}

/** Drop pastes old enough that no restored task still references them meaningfully. */
export async function cleanupPastes(): Promise<void> {
  const dir = pastesDir();
  const names = await readdir(dir).catch(() => [] as string[]);
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info?.isFile() && info.mtimeMs < cutoff) await unlink(path).catch(() => undefined);
  }
}
