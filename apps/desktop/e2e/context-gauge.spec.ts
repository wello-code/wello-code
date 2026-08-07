import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * The context gauge on a GPT model. Its number used to come only from the
 * per-message usage streamed mid-turn, which that family reports as zeros — so
 * the ring never rendered and people asked where their context meter went
 * (reported 2026-08-07). Opt-in like the other live specs.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Войти по API-ключу" }).click();
  await page.getByPlaceholder("wlo_live_").fill(KEY!);
  await page.getByRole("button", { name: "Подключить" }).click();
}

test("the context ring appears after a GPT turn", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(180_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-ctx-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-ctx-ud-"));
  await writeFile(join(ws, "readme.md"), "# project\n");
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await connect(page);
    await page.locator(".composer__project").click();
    await page.getByRole("button", { name: "Доверяю папке" }).click();

    await page.getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ }).first().click();
    await page.getByRole("option", { name: /GPT Terra/ }).click();

    await page.getByPlaceholder(/Спросите/).first().fill("Скажи одним словом: привет");
    await page.keyboard.press("Enter");

    // The ring is what the complaint was about: it must exist and hold a real
    // percentage once the turn settles.
    await expect(page.locator(".ctx__ring")).toBeVisible({ timeout: 120_000 });
    await page.locator(".ctx__ring").click();
    await expect(page.locator(".ctx__pct")).not.toHaveText("0%");
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
