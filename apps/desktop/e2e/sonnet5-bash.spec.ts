import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeApp, modelOffered } from "./helpers";

/**
 * Two reports from one person on 0.1.13, both on the default model: every run
 * «падает при попытке вызова Bash», and the context ring vanished.
 *
 * Both are asserted here on the model they were reported against, because both
 * failures are invisible to a suite that runs elsewhere: a shell call that ends
 * the turn looks like a short answer, and a missing ring looks like a quiet UI.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

test("Sonnet 5: a shell command runs, and the context ring is there", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(360_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-s5-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-s5-ud-"));
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
    // The model both reports were made on. It is temporarily out of the picker,
    // so this asks rather than fails — and runs again the day it returns.
    const offered = await modelOffered(page, /Sonnet 5/);
    test.skip(!offered, "Sonnet 5 is not in the picker right now");
    await page.getByRole("option", { name: /Sonnet 5/ }).click();
    await page.getByRole("button", { name: "Вручную" }).click();
    await page.getByRole("option", { name: /Полный доступ/ }).click();
    await page.getByRole("button", { name: "Понимаю, включить" }).click();

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill(
        "Выполни в терминале команду `node -e \"console.log(2+2)\"` и напиши, " +
          "что она вывела. Файлы не меняй.",
      );
    await page.keyboard.press("Enter");

    // The shell call has to survive: the report is that the run dies on it.
    await expect(page.locator(".msg", { hasText: "4" }).first()).toBeVisible({ timeout: 300_000 });
    await expect(page.locator(".note--danger")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Остановить" })).toHaveCount(0, {
      timeout: 120_000,
    });

    // And the ring: the number arrives with the turn's result, not with the first
    // frame of the answer, which is why it went missing.
    await expect(page.locator(".ctx__ring")).toBeVisible({ timeout: 60_000 });
    await page.locator(".ctx__ring").click();
    await expect(page.locator(".ctx__pct")).not.toHaveText("0%");
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
