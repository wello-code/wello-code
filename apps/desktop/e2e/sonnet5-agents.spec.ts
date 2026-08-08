import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * «Все агенты и субагенты падают при попытке вызова Bash» (0.1.13).
 *
 * The subagent path is what makes this its own spec: a delegated run reaches the
 * engine differently from the main one, and nothing here was covered by a live
 * test before. The second case is the shape the report almost certainly WAS —
 * the engine refusing a command by itself, which used to reach the person as
 * nothing at all: the step stayed «выполняется» and the run looked dead.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

async function open(
  page: Page,
  opts: { fullAccess?: boolean; plan?: boolean; auto?: boolean } = {},
): Promise<void> {
  await page.getByRole("button", { name: "Войти по API-ключу" }).click();
  await page.getByPlaceholder("wlo_live_").fill(KEY!);
  await page.getByRole("button", { name: "Подключить" }).click();
  await page.locator(".composer__project").click();
  await page.getByRole("button", { name: "Доверяю папке" }).click();
  await expect(page.getByRole("button", { name: /Sonnet 5/ }).first()).toBeVisible();
  if (opts.fullAccess) {
    await page.getByRole("button", { name: "Вручную" }).click();
    await page.getByRole("option", { name: /Полный доступ/ }).click();
    await page.getByRole("button", { name: "Понимаю, включить" }).click();
  }
  if (opts.plan) {
    await page.getByRole("button", { name: "Вручную" }).click();
    await page.getByRole("option", { name: "План" }).click();
  }
  if (opts.auto) {
    await page.getByRole("button", { name: "Вручную" }).click();
    await page.getByRole("option", { name: /Авто/ }).click();
  }
}

test("Sonnet 5: a subagent runs a shell command and reports back", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(420_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-sub-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-sub-ud-"));
  await writeFile(join(ws, "readme.md"), "# project\n");
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await open(page, { fullAccess: true });

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill(
        "Делегируй это отдельному субагенту (инструмент Agent): пусть он выполнит " +
          "в терминале `node -e \"console.log(7*6)\"` и вернёт вывод. " +
          "Затем напиши мне это число.",
      );
    await page.keyboard.press("Enter");

    await expect(page.locator(".msg", { hasText: "42" }).first()).toBeVisible({ timeout: 360_000 });
    await expect(page.locator(".note--danger")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Остановить" })).toHaveCount(0, {
      timeout: 120_000,
    });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("Sonnet 5: a command the engine refuses by itself is named, and the run ends", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(420_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-deny-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-deny-ud-"));
  await writeFile(join(ws, "readme.md"), "# project\n");
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    // «План» is where the engine blocks a mutating command on its own, without
    // consulting our permission card at all.
    await open(page, { plan: true });

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill(
        "Прямо сейчас, не планируя, выполни в терминале команду " +
          "`node -e \"require('fs').writeFileSync('out.txt','1')\"`.",
      );
    await page.keyboard.press("Enter");

    // Three outcomes are all acceptable, and one is not. The engine may refuse
    // the command itself (a line names it), or the app may ask (a card), or the
    // model may decide to plan instead. What must never happen is the 0.1.13
    // outcome: the run sitting on «выполняется» with nothing on screen and no way
    // forward — which is what «падает при вызове Bash» looks like from a chair.
    const running = page.getByRole("button", { name: "Остановить" });
    const card = page.locator(".perm");
    await expect
      .poll(async () => (await card.count()) > 0 || (await running.count()) === 0, {
        timeout: 300_000,
      })
      .toBe(true);

    // If it asked, declining has to end the run cleanly rather than wedge it.
    if ((await card.count()) > 0) {
      await card.getByRole("button", { name: "Отклонить" }).first().click();
    }
    await expect(running).toHaveCount(0, { timeout: 180_000 });
    // Nothing was written behind a refusal.
    expect(await readFile(join(ws, "out.txt"), "utf8").catch(() => null)).toBeNull();
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

/**
 * «Авто» hands every decision to the engine's own judge, and whether that judge
 * can reach a verdict is not something the app controls: measured 2026-08-08, it
 * answers for one model and returns «could not evaluate this action» for another,
 * on the same machine and the same command. So the invariant is asserted, not the
 * verdict: a person is told once, and the run ends either way. The «всё падает»
 * report was a column of identical red notes and a run that never settled.
 */
test("Sonnet 5: «Авто» never buries the person under repeated refusals", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(420_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-auto-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-auto-ud-"));
  await writeFile(join(ws, "readme.md"), "# project\n");
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await open(page, { auto: true });

    // Three commands in one turn: if the judge refuses, it refuses all three.
    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill(
        "Выполни в терминале три команды по очереди: `node -e \"console.log(11+11)\"`, " +
          "`node -e \"console.log(3*3)\"`, `node -e \"console.log(8-1)\"`. Напиши три результата.",
      );
    await page.keyboard.press("Enter");

    await expect(page.getByRole("button", { name: "Остановить" })).toHaveCount(0, {
      timeout: 360_000,
    });
    const danger = await page.locator(".note--danger").allInnerTexts();
    // At most one refusal note, and if there is one it has to say the way out.
    expect(danger.length, `refusal notes: ${danger.join(" || ")}`).toBeLessThanOrEqual(1);
    if (danger.length === 1) expect(danger[0]).toMatch(/Вручную|Полный доступ/);
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("Opus 5: «Авто» reaches a verdict and the command runs", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(420_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-auto2-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-auto2-ud-"));
  await writeFile(join(ws, "readme.md"), "# project\n");
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await open(page, {});
    await page
      .getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ })
      .first()
      .click();
    await page.getByRole("option", { name: /Opus 5/ }).click();
    await page.getByRole("button", { name: "Вручную" }).click();
    await page.getByRole("option", { name: /Авто/ }).click();

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill('Выполни в терминале `node -e "console.log(11+11)"` и напиши результат.');
    await page.keyboard.press("Enter");

    await expect(page.locator(".msg", { hasText: "22" }).first()).toBeVisible({ timeout: 360_000 });
    const danger = await page.locator(".note--danger").allInnerTexts();
    expect(danger, `feed carries a failure note: ${danger.join(" || ")}`).toHaveLength(0);
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
