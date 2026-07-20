import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * The preview pane end-to-end THROUGH THE UI: open the panel, type google.com
 * in the address bar (the site the old iframe showed as a silent white frame),
 * and prove the native view actually rendered it — via previewViewCapture, a
 * real screenshot of the browser surface. Costs no model turns; opt-in like
 * live.spec because login needs a key.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

test("live UI: превью открывает google.com в нативном вью и снимает его", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(240_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-pv-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-pv-ud-"));
  await writeFile(join(ws, "README.md"), "# preview smoke\n");

  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Войти по API-ключу" }).click();
    await page.getByPlaceholder("wlo_live_").fill(KEY!);
    await page.getByRole("button", { name: "Подключить" }).click();
    await page.locator(".composer__project").click();
    await page.getByRole("button", { name: "Доверяю папке" }).click();

    await page.locator('button[aria-label="Открыть превью"]').click();
    const addr = page.locator(".preview__addr");
    await expect(addr).toBeVisible({ timeout: 15_000 });
    await addr.fill("google.com");
    await addr.press("Enter");

    // The native surface attached and actually landed on google.*.
    const viewUrl = () =>
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        const child = win?.contentView.children[0] as
          | { webContents?: { getURL(): string } }
          | undefined;
        return child?.webContents?.getURL() ?? "";
      });
    await expect.poll(viewUrl, { timeout: 60_000 }).toContain("google.");

    // Screenshot of the page itself (nothing else can capture a child view).
    await page.waitForTimeout(1500);
    const shotPath = await page.evaluate(() => window.wello.previewViewCapture());
    expect(shotPath).toBeTruthy();
    const info = await stat(shotPath!);
    expect(info.size).toBeGreaterThan(10_000);

    // The omnibox now mirrors the live URL; back is still disabled (first page).
    const addrValue = await addr.inputValue();
    expect(addrValue).toContain("google.");

    // Overlays paint UNDER the native surface — opening one must detach the
    // view (real build, real IPC), closing it must bring the page back.
    const childCount = () =>
      app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return win ? win.contentView.children.length : -1;
      });
    await page.keyboard.press("Control+KeyK");
    await expect.poll(childCount, { timeout: 15_000 }).toBe(0);
    await page.keyboard.press("Escape");
    await expect.poll(childCount, { timeout: 15_000 }).toBe(1);
  } finally {
    await closeApp(app).catch(() => {});
  }
});
