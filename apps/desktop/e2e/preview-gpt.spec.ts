import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * The agent LOOKING at the preview pane, on a GPT model. That family used to be
 * told not to open the screenshot at all (their bridge refused an image inside a
 * tool result); the gateway carries it now, so the same instruction serves every
 * model — this proves it end to end. Opt-in like the other live specs.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

test("GPT: the agent captures the preview pane and reads its console", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(300_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-pvg-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-pvg-ud-"));
  // A page with one unmistakable word on it and one console error, so the
  // answer can only come from actually looking at the pane.
  await writeFile(
    join(ws, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>t</title>
<body style="background:#fff;color:#000;font:48px sans-serif">СИРЕНЬ-91</body>
<script>console.error("тестовая ошибка консоли 42")</script>`,
  );
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
    await page.getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ }).first().click();
    await page.getByRole("option", { name: /GPT Terra/ }).click();
    await page.getByRole("button", { name: "Вручную" }).click();
    await page.getByRole("option", { name: /Полный доступ/ }).click();
    await page.getByRole("button", { name: "Понимаю, включить" }).click();

    // Open the pane on the project's own page (the app serves the folder).
    await page.locator('button[aria-label="Открыть превью"]').click();
    await expect(page.locator(".preview__addr")).toBeVisible({ timeout: 20_000 });

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill(
        "Посмотри на панель превью своим инструментом и ответь двумя вещами: какое слово " +
          "написано на странице и какая ошибка в консоли. Файлы не меняй.",
      );
    await page.keyboard.press("Enter");

    // Either half proves the tool worked: the word can only come from the
    // screenshot, the error only from the console tail it returns.
    await expect(
      page.locator(".msg", { hasText: /СИРЕНЬ-91|тестовая ошибка консоли 42/ }).first(),
    ).toBeVisible({ timeout: 240_000 });
    // And the old failure mode must be gone.
    await expect(page.locator(".msg", { hasText: "tool-result-image" })).toHaveCount(0);
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
