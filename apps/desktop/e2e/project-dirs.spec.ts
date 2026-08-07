import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * «Папки проекта» — attaching a second folder so the agent can work across two
 * repositories (support report, 2026-08-07: «модель ограничена одной папкой
 * проекта»). Opt-in like the other live specs: connecting needs a real key.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Войти по API-ключу" }).click();
  await page.getByPlaceholder("wlo_live_").fill(KEY!);
  await page.getByRole("button", { name: "Подключить" }).click();
}

test("attach a second folder to the project, then detach it", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(120_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-dirs-ws-"));
  const other = await mkdtemp(join(tmpdir(), "wello-dirs-other-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-dirs-ud-"));
  await writeFile(join(ws, "readme.md"), "# project\n");
  await writeFile(join(other, "note.txt"), "second repo\n");
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    // The picker answers with the project folder first, the second folder after.
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
    await connect(page);
    await page.locator(".composer__project").click();
    await page.getByRole("button", { name: "Доверяю папке" }).click();

    // Start a chat so the chat header (and its menu) exists.
    await page.getByPlaceholder(/Спросите/).first().fill("привет");
    await page.keyboard.press("Enter");
    await expect(page.locator(".chattitle__btn")).toBeVisible({ timeout: 30_000 });

    await page.locator(".chattitle__btn").click();
    await page.getByRole("menuitem", { name: "Папки проекта" }).click();
    await expect(page.getByText("Папки проекта")).toBeVisible();

    // The project itself is listed and cannot be removed; the attached one can.
    await expect(page.locator(".dirlist__row.is-root")).toBeVisible();
    await page.getByRole("button", { name: "Добавить папку" }).click();
    const attached = page.locator(".dirlist__row:not(.is-root)");
    await expect(attached).toHaveCount(1, { timeout: 10_000 });

    // Reopening the menu shows the count badge — the state is persisted, not
    // just modal-local.
    await page.locator(".modal__actions button", { hasText: "Закрыть" }).click();
    await page.locator(".chattitle__btn").click();
    await expect(page.locator(".taskmenu__count")).toHaveText("+1");
    await page.getByRole("menuitem", { name: "Папки проекта" }).click();

    await page.locator(".dirlist__row:not(.is-root) .icon-button").click();
    await expect(page.locator(".dirlist__row:not(.is-root)")).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("the agent actually reaches an attached folder, and «Полный доступ» never asks about a plan", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(240_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-dirs2-ws-"));
  const other = await mkdtemp(join(tmpdir(), "wello-dirs2-other-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-dirs2-ud-"));
  await writeFile(join(ws, "readme.md"), "# project\n");
  await writeFile(join(other, "note.txt"), "ORANGE-4417 lives in the second repository\n");
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
    await connect(page);
    await page.locator(".composer__project").click();
    await page.getByRole("button", { name: "Доверяю папке" }).click();

    // A GPT model on purpose: it is the family where the plan card and the
    // attached folder both first went wrong, and it does not depend on the
    // Claude family being up.
    await page.getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ }).first().click();
    await page.getByRole("option", { name: /GPT Terra/ }).click();

    // «Полный доступ»: the mode that promises never to ask anything.
    await page.getByRole("button", { name: "Вручную" }).click();
    await page.getByRole("option", { name: /Полный доступ/ }).click();
    await page.getByRole("button", { name: "Понимаю, включить" }).click();

    await page.getByPlaceholder(/Спросите/).first().fill("привет");
    await page.keyboard.press("Enter");
    await expect(page.locator(".chattitle__btn")).toBeVisible({ timeout: 60_000 });
    await page.locator(".chattitle__btn").click();
    await page.getByRole("menuitem", { name: "Папки проекта" }).click();
    await page.getByRole("button", { name: "Добавить папку" }).click();
    await expect(page.locator(".dirlist__row:not(.is-root)")).toHaveCount(1, { timeout: 10_000 });
    await page.locator(".modal__actions button", { hasText: "Закрыть" }).click();

    // One turn that has to (a) plan and leave plan mode, (b) read a file that
    // only exists in the attached folder. A permission card in bypass mode is
    // the bug this test exists for. The greeting turn has to settle first, or
    // this message would queue behind it.
    await expect(page.getByRole("button", { name: "Остановить" })).toHaveCount(0, {
      timeout: 60_000,
    });
    await page
      .getByPlaceholder(/Запросите|Спросите/)
      .first()
      .fill(
        `Сначала вызови инструмент EnterPlanMode, потом ExitPlanMode с планом из одной строки. ` +
          `После этого прочитай файл ${join(other, "note.txt")} и напиши, какой код в нём указан.`,
      );
    await page.keyboard.press("Enter");

    await expect(page.locator(".msg", { hasText: "ORANGE-4417" }).first()).toBeVisible({
      timeout: 180_000,
    });
    // Nothing was ever asked: no permission card appeared during the turn.
    await expect(page.locator(".perm")).toHaveCount(0);
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
