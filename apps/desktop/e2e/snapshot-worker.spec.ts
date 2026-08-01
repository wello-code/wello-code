import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * The snapshot store runs in a worker thread, and that is the whole point: its
 * thousands of filesystem calls used to fill the main process's thread pool, so
 * the window got no answer to its own IPC exactly while a turn was starting.
 *
 * The worker is a SECOND build entry (see electron.vite.config.ts) — a packaging
 * mistake would leave `out/main/snapshot-worker.js` missing, the host would fall
 * back to running everything in the main process, and everything would still
 * "work", just slowly. That silent regression is what this pins.
 */

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("snapshot work is served by the worker, not the main process", async () => {
  const profile = await mkdtemp(join(tmpdir(), "wello-worker-"));
  const workspace = await mkdtemp(join(tmpdir(), "wello-worker-ws-"));
  await writeFile(join(workspace, "app.ts"), "export const a = 1;\n");

  const app = await electron.launch({ args: [appDir, `--user-data-dir=${profile}`] });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Any snapshot call will do; this one needs no workspace grant and no account.
    const exists = await page.evaluate(() =>
      (
        window as unknown as {
          wello: { checkpointExists(taskId: string, turnId: string): Promise<boolean> };
        }
      ).wello.checkpointExists("e2e-task", "e2e-run"),
    );
    expect(exists, "a checkpoint that was never taken").toBe(false);

    const info = await page.evaluate(() =>
      (
        window as unknown as { wello: { getAppInfo(): Promise<{ logPath: string }> } }
      ).wello.getAppInfo(),
    );
    const log = await readFile(info.logPath, "utf8");
    // The host logs this line the moment it gives up on the worker. Its absence,
    // together with an answered call, means the worker served it.
    expect(log, "the worker must load; the fallback is for broken installs only").not.toContain(
      "snapshot worker unusable",
    );
  } finally {
    await closeApp(app);
  }
});
