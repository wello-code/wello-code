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
