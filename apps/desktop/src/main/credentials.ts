import { app, safeStorage } from "electron";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Stores the Wello API key encrypted at rest in the OS keychain via Electron
 * safeStorage (userData, never the renderer, never git). If the platform has no
 * keychain, we fall back to a plaintext file in userData — still off-renderer and
 * off-repo, but note the weaker guarantee. The renderer only ever sees connection
 * STATUS, never the key itself.
 */
const FILE = "wello-credentials.bin";

function credentialsPath(): string {
  return join(app.getPath("userData"), FILE);
}

export async function setApiKey(key: string): Promise<void> {
  const bytes = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(key)
    : Buffer.from(key, "utf8");
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(credentialsPath(), bytes);
}

export async function getApiKey(): Promise<string | null> {
  try {
    const bytes = await readFile(credentialsPath());
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(bytes);
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

export async function clearApiKey(): Promise<void> {
  await rm(credentialsPath(), { force: true });
}
