import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

/**
 * The native preview browser (WebContentsView) end-to-end in REAL Electron:
 * attach → load a site that FORBIDS iframing (google.com — the exact case the
 * old iframe rendered as a silent white frame) → navigate → destroy. Driven
 * through the same window.wello IPC surface the preview pane uses, so this
 * exercises preload + main wiring, not a private test path. No API key needed.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("preview view: loads iframe-hostile sites (google) and detaches cleanly", async () => {
  test.setTimeout(180_000);
  const userData = await mkdtemp(join(tmpdir(), "wello-pv-ud-"));
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector("#root *", { timeout: 30_000 });

    const childCount = () =>
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return win ? win.contentView.children.length : -1;
      });
    const viewUrl = () =>
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const child = win?.contentView.children[0] as
          | { webContents?: { getURL(): string } }
          | undefined;
        return child?.webContents?.getURL() ?? "";
      });

    const base = await childCount();

    // Attach + load example.com (fast, stable) through the real IPC surface.
    await page.evaluate(() =>
      window.wello.previewViewShow(
        { x: 40, y: 40, width: 640, height: 480 },
        "https://example.com/",
        "desktop",
      ),
    );
    await expect.poll(childCount, { timeout: 30_000 }).toBe(base + 1);
    await expect.poll(viewUrl, { timeout: 45_000 }).toContain("example.com");

    // Navigate to google.com — X-Frame-Options киллер айфрейма; the native
    // view must actually land on it (URL changes to google.*).
    await page.evaluate(() =>
      window.wello.previewViewShow(
        { x: 40, y: 40, width: 640, height: 480 },
        "https://www.google.com/",
        "desktop",
      ),
    );
    await expect.poll(viewUrl, { timeout: 60_000 }).toContain("google.");

    // The renderer received live nav state over previewview.state.
    const navSeen = await page.evaluate(
      () =>
        new Promise<boolean>((resolve) => {
          const off = window.wello.onPreviewViewState((s) => {
            if (s.url.includes("google.")) {
              off();
              resolve(true);
            }
          });
          void window.wello.previewViewReload();
          setTimeout(() => resolve(false), 30_000);
        }),
    );
    expect(navSeen).toBe(true);

    // Device emulation round-trip must not crash (disableDeviceEmulation on a
    // page-less webContents is a native crash on win32 — guarded in main).
    await page.evaluate(() =>
      window.wello.previewViewShow(
        { x: 40, y: 40, width: 320, height: 480 },
        "https://www.google.com/",
        "mobile",
      ),
    );
    await page.waitForTimeout(800);
    await page.evaluate(() =>
      window.wello.previewViewShow(
        { x: 40, y: 40, width: 640, height: 480 },
        "https://www.google.com/",
        "desktop",
      ),
    );
    await expect.poll(viewUrl, { timeout: 30_000 }).toContain("google.");

    // Hide detaches but keeps the surface; destroy frees it.
    await page.evaluate(() => window.wello.previewViewHide());
    await expect.poll(childCount, { timeout: 15_000 }).toBe(base);
    await page.evaluate(() => window.wello.previewViewDestroy());
    await expect.poll(childCount, { timeout: 15_000 }).toBe(base);
  } finally {
    await app.close().catch(() => {});
  }
});
