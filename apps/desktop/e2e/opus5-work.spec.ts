import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * Opus 5 doing the job people actually bought the app for, and the two controls
 * they reach for while it does: stopping a run, and changing model mid-chat.
 *
 * The single-turn specs next door prove each capability in isolation; these prove
 * the shapes that only appear over a whole task — many tools in one turn, a
 * terminal command, and a thread that outlives a switch of model.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Войти по API-ключу" }).click();
  await page.getByPlaceholder("wlo_live_").fill(KEY!);
  await page.getByRole("button", { name: "Подключить" }).click();
}

async function useOpus5(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ })
    .first()
    .click();
  await page.getByRole("option", { name: /Opus 5/ }).click();
  await expect(page.getByRole("button", { name: /Opus 5/ }).first()).toBeVisible();
}

async function fullAccess(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Вручную" }).click();
  await page.getByRole("option", { name: /Полный доступ/ }).click();
  await page.getByRole("button", { name: "Понимаю, включить" }).click();
}

async function trustProject(page: Page): Promise<void> {
  await page.locator(".composer__project").click();
  await page.getByRole("button", { name: "Доверяю папке" }).click();
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

test("Opus 5: a real task — writes a file, runs it, and reports the result", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(420_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-o5-task-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-o5-task-ud-"));
  await writeFile(
    join(ws, "readme.md"),
    "# калькулятор\n\nНужен sum.js: функция sum(a,b) и печать sum(2,3).\n",
  );
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await connect(page);
    await trustProject(page);
    await useOpus5(page);
    await fullAccess(page);

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill(
        "Прочитай readme.md, создай sum.js по описанию и запусти его через node. " +
          "В конце напиши, что вывела программа.",
      );
    await page.keyboard.press("Enter");

    // The whole point of the app: the file exists on disk and the program ran.
    await expect
      .poll(async () => readFile(join(ws, "sum.js"), "utf8").catch(() => ""), {
        timeout: 300_000,
      })
      .toContain("sum");
    await expect(page.locator(".msg", { hasText: "5" }).first()).toBeVisible({ timeout: 300_000 });
    // A multi-tool turn is where a half-working setup shows up as a dead thread
    // rather than an error, so the run must have actually settled.
    await expect(page.getByRole("button", { name: "Остановить" })).toHaveCount(0, {
      timeout: 120_000,
    });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("Opus 5: «Стоп» ends the run calmly, and the chat still takes the next turn", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(360_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-o5-stop-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-o5-stop-ud-"));
  await writeFile(join(ws, "readme.md"), "# project\n");
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await connect(page);
    await trustProject(page);
    await useOpus5(page);
    await fullAccess(page);

    // Something long enough to still be running when Stop is pressed.
    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill("Напиши очень подробный рассказ про море, не меньше двух тысяч слов.");
    await page.keyboard.press("Enter");

    const stop = page.getByRole("button", { name: "Остановить" });
    await expect(stop).toBeVisible({ timeout: 120_000 });
    await stop.click();

    // A cancel is a calm line, not a red failure — and it must not be reported as
    // an upstream problem, because it is not one.
    await expect(page.locator(".note--cancelled")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".note--danger")).toHaveCount(0);
    await expect(stop).toHaveCount(0, { timeout: 60_000 });

    // And the thread is still usable: a stop must not poison the session.
    await page
      .getByPlaceholder(/Запросите|Спросите/)
      .first()
      .fill("Ответь одним словом: продолжаем");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg", { hasText: /продолжаем/i }).first()).toBeVisible({
      timeout: 240_000,
    });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("Opus 5: a chat started on another model keeps going after switching to it", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(420_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-o5-swap-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-o5-swap-ud-"));
  git(ws, ["init"]);
  await writeFile(join(ws, "readme.md"), "# project\n");
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await connect(page);
    await trustProject(page);
    await fullAccess(page);

    // Turn one on the default model: plant a fact only this thread knows.
    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill("Запомни на этот диалог число 4417. Ответь одним словом: принято");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg", { hasText: /принято/i }).first()).toBeVisible({
      timeout: 240_000,
    });
    await expect(page.getByRole("button", { name: "Остановить" })).toHaveCount(0, {
      timeout: 90_000,
    });

    // Switch model mid-thread. The engine session is keyed on the model, so this
    // is where a thread can silently lose everything said before it.
    await useOpus5(page);
    await page
      .getByPlaceholder(/Запросите|Спросите/)
      .first()
      .fill("Какое число я просил запомнить? Ответь только числом.");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg", { hasText: "4417" }).first()).toBeVisible({
      timeout: 240_000,
    });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
