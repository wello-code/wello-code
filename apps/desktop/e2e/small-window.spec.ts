import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * The composer's menus open UPWARD. In a short window the model list used to run
 * off the top of the screen, with its first entries unreachable (reported
 * 2026-08-07 with a screenshot). Nothing here needs a model, only a small window.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

test("in a short window the model picker stays on screen", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(120_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-small-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-small-ud-"));
  await writeFile(join(ws, "readme.md"), "# project\n");
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

    // The window from the report: wide enough, but short — shrunk while working,
    // which is exactly how a person meets this.
    await app.evaluate(async ({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setSize(1280, 560);
    });
    await page.waitForTimeout(300);

    await page.getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ }).first().click();
    const menu = page.locator('.modelsel__menu[aria-label="Модель"]');
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0); // the top edge is on screen
    // Its first entry is reachable, which is what «улетает за экран» cost.
    await expect(menu.getByRole("option").first()).toBeVisible();
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("«ещё папки» is reachable from the project row, before any chat exists", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(120_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-dirs3-ws-"));
  const other = await mkdtemp(join(tmpdir(), "wello-dirs3-other-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-dirs3-ud-"));
  await writeFile(join(ws, "readme.md"), "# project\n");
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(
      async ({ dialog }, paths) => {
        const queue = [...paths];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (dialog as any).showOpenDialog = async () => ({
          canceled: false,
          filePaths: [queue.shift() ?? paths[paths.length - 1]],
        });
      },
      [ws, other],
    );
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Войти по API-ключу" }).click();
    await page.getByPlaceholder("wlo_live_").fill(KEY!);
    await page.getByRole("button", { name: "Подключить" }).click();
    await page.locator(".composer__project").click();
    await page.getByRole("button", { name: "Доверяю папке" }).click();

    // No chat has been started: this is where a person looks for it.
    await page.getByRole("button", { name: /ещё папки/ }).click();
    await page.getByRole("button", { name: "Добавить папку" }).click();
    await expect(page.locator(".dirlist__row:not(.is-root)")).toHaveCount(1, { timeout: 10_000 });
    await page.locator(".modal__actions button", { hasText: "Закрыть" }).click();
    // The chip counts what is attached, so the state is visible without opening it.
    await expect(page.locator(".projectdirs__count")).toHaveText("+1");
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
