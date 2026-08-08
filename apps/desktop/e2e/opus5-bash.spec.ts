import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * «Все агенты и субагенты падают при попытке вызова Bash» — reported on Opus 5.
 *
 * Every combination here is one this model reaches differently from the others:
 * it is the reasoning model, so the top of the effort scale sends an explicit
 * thinking budget, and a turn that thinks BEFORE calling a tool has to carry the
 * thinking block (with its signature) back alongside the tool result. That round
 * trip is exactly where a shell call dies without the run ever saying why.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Войти по API-ключу" }).click();
  await page.getByPlaceholder("wlo_live_").fill(KEY!);
  await page.getByRole("button", { name: "Подключить" }).click();
  await page.locator(".composer__project").click();
  await page.getByRole("button", { name: "Доверяю папке" }).click();
}

async function useOpus5(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ })
    .first()
    .click();
  await page.getByRole("option", { name: /Opus 5/ }).click();
  await expect(page.getByRole("button", { name: /Opus 5/ }).first()).toBeVisible();
}

/** Move the Faster↔Smarter slider; 4 = «Максимум», which rides a thinking budget. */
async function setEffort(page: Page, index: number, label: string): Promise<void> {
  await page
    .getByRole("button", { name: /Opus 5/ })
    .first()
    .click();
  await page.locator('input[aria-label="Усилие модели"]').fill(String(index));
  await expect(page.locator(".effort__value")).toHaveText(label);
  await page.keyboard.press("Escape");
}

async function fullAccess(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Вручную" }).click();
  await page.getByRole("option", { name: /Полный доступ/ }).click();
  await page.getByRole("button", { name: "Понимаю, включить" }).click();
}

async function launch(prefix: string): Promise<{
  app: Awaited<ReturnType<typeof electron.launch>>;
  ws: string;
  userData: string;
}> {
  const ws = await mkdtemp(join(tmpdir(), `wello-${prefix}-ws-`));
  const userData = await mkdtemp(join(tmpdir(), `wello-${prefix}-ud-`));
  await writeFile(join(ws, "readme.md"), "# project\n");
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  await app.evaluate(async ({ dialog }, wsPath) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
  }, ws);
  return { app, ws, userData };
}

test("Opus 5: a shell command at the top of the effort scale, where the turn thinks first", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(480_000);
  const { app, ws, userData } = await launch("o5bash-max");
  try {
    const page = await app.firstWindow();
    await connect(page);
    await useOpus5(page);
    await fullAccess(page);
    await setEffort(page, 4, "Максимум");

    // Reasoning is demanded BEFORE the call, so the assistant turn carries a
    // thinking block and a tool_use together — the shape that has to survive.
    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill(
        "Сначала обдумай, какая команда покажет версию node надёжнее всего, " +
          "потом выполни её в терминале и напиши, что она вывела.",
      );
    await page.keyboard.press("Enter");

    await expect(page.locator(".msg", { hasText: /v\d+\./ }).first()).toBeVisible({
      timeout: 420_000,
    });
    const danger = await page.locator(".note--danger").allInnerTexts();
    expect(danger, `feed carries a failure note: ${danger.join(" || ")}`).toHaveLength(0);
    await expect(page.getByRole("button", { name: "Остановить" })).toHaveCount(0, {
      timeout: 120_000,
    });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("Opus 5: a subagent runs a shell command and reports back", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(480_000);
  const { app, ws, userData } = await launch("o5bash-sub");
  try {
    const page = await app.firstWindow();
    await connect(page);
    await useOpus5(page);
    await fullAccess(page);

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill(
        "Делегируй это отдельному субагенту (инструмент Agent): пусть он выполнит " +
          'в терминале `node -e "console.log(7*6)"` и вернёт вывод. Затем напиши мне это число.',
      );
    await page.keyboard.press("Enter");

    await expect(page.locator(".msg", { hasText: "42" }).first()).toBeVisible({ timeout: 420_000 });
    const danger = await page.locator(".note--danger").allInnerTexts();
    expect(danger, `feed carries a failure note: ${danger.join(" || ")}`).toHaveLength(0);
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("Opus 5: in «Вручную» a command is approved on a card and then runs", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(480_000);
  const { app, ws, userData } = await launch("o5bash-manual");
  try {
    const page = await app.firstWindow();
    await connect(page);
    await useOpus5(page);
    // «Вручную» is the default mode, so this is the path most people are on.

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill('Выполни в терминале `node -e "console.log(5*5)"` и напиши результат.');
    await page.keyboard.press("Enter");

    // Answer whatever it asks for, up to a few cards, then the command must run.
    const card = page.locator(".perm");
    for (let i = 0; i < 4; i++) {
      const appeared = await card
        .waitFor({ state: "visible", timeout: 120_000 })
        .then(() => true)
        .catch(() => false);
      if (!appeared) break;
      await card.getByRole("button", { name: "Разрешить один раз" }).click();
      await expect(card).toBeHidden({ timeout: 60_000 });
      if ((await page.locator(".msg", { hasText: "25" }).count()) > 0) break;
    }
    await expect(page.locator(".msg", { hasText: "25" }).first()).toBeVisible({ timeout: 300_000 });
    const danger = await page.locator(".note--danger").allInnerTexts();
    expect(danger, `feed carries a failure note: ${danger.join(" || ")}`).toHaveLength(0);
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
