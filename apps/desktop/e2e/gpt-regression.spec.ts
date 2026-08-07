import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * The unreleased work, exercised end to end on a GPT model — the family where
 * every one of these broke first: images inside tool results, the context gauge,
 * plan approval, project memory. Opt-in like the other live specs.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;
/** A 1×1 png, so a Read of it is a real image without a real download. */
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Войти по API-ключу" }).click();
  await page.getByPlaceholder("wlo_live_").fill(KEY!);
  await page.getByRole("button", { name: "Подключить" }).click();
}

/** Switch the picker to GPT Terra (the model these regressions live on). */
async function useGpt(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ }).first().click();
  await page.getByRole("option", { name: /GPT Terra/ }).click();
}

test("GPT: reads an image, keeps project memory, and shows the context gauge", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(300_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-gpt-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-gpt-ud-"));
  await writeFile(join(ws, "readme.md"), "# project\n");
  await writeFile(join(ws, "logo.png"), Buffer.from(PNG_1PX, "base64"));
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
    await useGpt(page);
    // «Полный доступ»: no cards, so the run is one uninterrupted turn.
    await page.getByRole("button", { name: "Вручную" }).click();
    await page.getByRole("option", { name: /Полный доступ/ }).click();
    await page.getByRole("button", { name: "Понимаю, включить" }).click();

    // 1. An image inside a tool result. This exact turn used to die with
    //    «400 … tool-result-image» and poison the whole chat.
    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill("Открой файл logo.png инструментом Read и ответь одним словом: РАЗМЕР-ОК");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg", { hasText: "РАЗМЕР-ОК" }).first()).toBeVisible({
      timeout: 180_000,
    });
    await expect(page.locator(".msg", { hasText: "tool-result-image" })).toHaveCount(0);

    // 2. The context gauge. On this family the number rides the turn's RESULT,
    //    which lands a moment after the last word of the answer — so the ring
    //    appears when the turn settles, not while it streams.
    await expect(page.locator(".ctx__ring")).toBeVisible({ timeout: 60_000 });

    // 3. Project memory — the agent's own notes, stored by the app.
    // Wait for the turn to settle: mid-run the composer says «Печатайте —
    // отправлю после ответа» and a follow-up would queue instead of running.
    await expect(page.getByRole("button", { name: "Остановить" })).toHaveCount(0, {
      timeout: 60_000,
    });
    await page
      .getByPlaceholder(/Запросите|Спросите/)
      .first()
      .fill("Запомни в память проекта: кодовое слово АПЕЛЬСИН-77. Ответь одним словом: записал");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg", { hasText: /записал/i }).first()).toBeVisible({
      timeout: 180_000,
    });
    await page.locator(".chattitle__btn").click();
    await page.getByRole("menuitem", { name: "Память проекта" }).click();
    await expect(page.locator(".memoryview")).toContainText("АПЕЛЬСИН-77");
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("GPT: «План» asks before it executes, and the mode returns to work after approval", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(300_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-plan-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-plan-ud-"));
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
    await useGpt(page);
    await page.getByRole("button", { name: "Вручную" }).click();
    await page.getByRole("option", { name: "План" }).click();

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill("Добавь в readme.md строку «привет». Сначала составь план и предложи его.");
    await page.keyboard.press("Enter");

    // The plan card is its own capability: allow-once or decline, and no grant
    // can ever answer it in advance.
    const card = page.locator(".perm");
    await expect(card).toBeVisible({ timeout: 180_000 });
    await expect(card).toContainText("план");
    await expect(card.getByRole("button", { name: "Разрешить для проекта" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Разрешить для задачи" })).toHaveCount(0);
    // While planning, the file must still be untouched.
    expect(await readFile(join(ws, "readme.md"), "utf8")).not.toContain("привет");

    await card.getByRole("button", { name: "Разрешить один раз" }).click();
    // Approving a plan leaves plan mode, or the next turn would just plan again.
    await expect(page.getByRole("button", { name: "План" })).toHaveCount(0, { timeout: 30_000 });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
