import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

// Launch the built app by its directory so Electron resolves package.json "main".
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("packaged renderer is sandboxed and reachable only via the typed bridge", async () => {
  const app = await electron.launch({ args: [appDir] });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Hardening: the renderer must have no Node/Electron reach-through.
    const exposure = await page.evaluate(() => ({
      hasRequire: "require" in window,
      hasProcess: "process" in window,
      hasWello: "wello" in window,
    }));
    expect(exposure.hasRequire, "renderer must not expose require()").toBe(false);
    expect(exposure.hasProcess, "renderer must not expose process").toBe(false);
    expect(exposure.hasWello, "typed bridge window.wello must be present").toBe(true);

    // The typed bridge round-trips to main.
    const pong = await page.evaluate(() =>
      (window as unknown as { wello: { ping(): Promise<string> } }).wello.ping(),
    );
    expect(pong).toBe("pong");

    const info = await page.evaluate(() =>
      (window as unknown as { wello: { getAppInfo(): Promise<{ version: string }> } }).wello.getAppInfo(),
    );
    expect(typeof info.version).toBe("string");
  } finally {
    await app.close();
  }
});

// A silent logger is worse than none: it looks fine until someone asks a user for
// the file and there is nothing there. Launch into a throwaway profile and assert
// main actually wrote the startup line to the path it advertises.
test("main writes a log file and reports its real path", async () => {
  const profile = await mkdtemp(join(tmpdir(), "wello-log-"));
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${profile}`] });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    const info = await page.evaluate(() =>
      (window as unknown as { wello: { getAppInfo(): Promise<{ logPath: string }> } }).wello.getAppInfo(),
    );
    expect(info.logPath, "the advertised path must live in this run's profile").toContain(profile);

    const contents = await readFile(info.logPath, "utf8");
    expect(contents, "startup must be recorded").toContain("app starting");
    expect(contents).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO {2}app starting/m);

    // Prove the crash handler is actually wired, not just defined: reject inside the
    // MAIN process and expect it on disk. (Deliberately the rejection path and not
    // uncaughtException — the latter raises a modal error box that would hang here.)
    await app.evaluate(() => {
      void Promise.reject(new Error("e2e crash-handler probe"));
    });
    await expect
      .poll(async () => readFile(info.logPath, "utf8"), { timeout: 5_000 })
      .toContain("unhandled promise rejection");
    expect(await readFile(info.logPath, "utf8")).toContain("e2e crash-handler probe");
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true });
  }
});
