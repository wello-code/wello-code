import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * The whole unreleased feature set, run on Opus 5.
 *
 * Why a suite of its own, next to the GPT one: what this model can do changed
 * underneath us. Prompt cache, vision and thinking all behave differently than
 * they did a week ago, and those three are exactly what an agent leans on
 * hardest. A suite that only proved «the app works on SOME model» would have
 * said yes throughout.
 *
 * Each test drives the built app, so what is asserted is what a person sees.
 * Opt-in like the other live specs: a real account key spends real allowance.
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

/**
 * Select Opus 5 — and on the way, check the two things a fresh profile shows:
 * this model is the DEFAULT (everything else falls back to it), and the picker
 * explains why the list is short, where a person looks for a missing model.
 */
async function useOpus5(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ })
    .first()
    .click();
  await expect(page.locator(".modelsel__note")).toBeVisible();
  // «Opus 5» and not /Opus/: were Opus 4.8 ever back in the list, a loose match
  // would quietly pass every assertion below on the wrong model.
  await page.getByRole("option", { name: /Opus 5/ }).click();
  await expect(page.getByRole("button", { name: /Opus 5/ }).first()).toBeVisible();
}

/** The mode that promises to ask nothing, so a run is one uninterrupted turn. */
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

test("Opus 5: reads an image through a tool, keeps project memory, shows the context gauge", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(360_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-o5-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-o5-ud-"));
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
    await trustProject(page);
    // A fresh profile has picked nothing yet, so what the button shows IS the
    // default — and everything that falls back to a model has to agree with it.
    await expect(page.getByRole("button", { name: /Opus 5/ }).first()).toBeVisible();
    await useOpus5(page);
    await fullAccess(page);

    // 1. An image inside a tool result. This model sees pictures again, so the
    //    turn has to complete with the answer in it.
    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill("Открой файл logo.png инструментом Read и ответь одним словом: РАЗМЕР-ОК");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg", { hasText: "РАЗМЕР-ОК" }).first()).toBeVisible({
      timeout: 240_000,
    });
    // The two failure shapes this exact turn had on the way here: a bridge
    // refusal, and an upstream error forwarded as if it were an answer.
    await expect(page.locator(".msg", { hasText: "tool-result-image" })).toHaveCount(0);
    await expect(page.locator(".msg", { hasText: /image.*not supported|invalid_request/i })).toHaveCount(0);

    // 2. The context gauge, dividing by this model's real window.
    await expect(page.locator(".ctx__ring")).toBeVisible({ timeout: 90_000 });
    await page.locator(".ctx__ring").click();
    await expect(page.locator(".ctx__pct")).not.toHaveText("0%");

    // 3. Project memory. Wait for the turn to settle first — mid-run a follow-up
    //    queues instead of running.
    await expect(page.getByRole("button", { name: "Остановить" })).toHaveCount(0, {
      timeout: 90_000,
    });
    await page
      .getByPlaceholder(/Запросите|Спросите/)
      .first()
      .fill("Запомни в память проекта: кодовое слово АПЕЛЬСИН-77. Ответь одним словом: записал");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg", { hasText: /записал/i }).first()).toBeVisible({
      timeout: 240_000,
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

test("Opus 5: «План» asks before it executes, and the mode returns to work after approval", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(360_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-o5-plan-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-o5-plan-ud-"));
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
    await page.getByRole("button", { name: "Вручную" }).click();
    await page.getByRole("option", { name: "План" }).click();

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill("Добавь в readme.md строку «привет». Сначала составь план и предложи его.");
    await page.keyboard.press("Enter");

    // The plan card is its own capability: allow-once or decline, and no standing
    // grant can answer it in advance.
    const card = page.locator(".perm");
    await expect(card).toBeVisible({ timeout: 240_000 });
    await expect(card).toContainText("план");
    await expect(card.getByRole("button", { name: "Разрешить для проекта" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Разрешить для задачи" })).toHaveCount(0);
    // While planning, the file must still be untouched.
    expect(await readFile(join(ws, "readme.md"), "utf8")).not.toContain("привет");

    await card.getByRole("button", { name: "Разрешить один раз" }).click();
    // Approving a plan leaves plan mode, or the next turn would just plan again.
    await expect(page.getByRole("button", { name: "План" })).toHaveCount(0, { timeout: 60_000 });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("Opus 5: an edit is approved with its diff in front of you, then commented on line by line", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(360_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-o5-edit-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-o5-edit-ud-"));
  git(ws, ["init"]);
  git(ws, ["config", "user.email", "test@wello.dev"]);
  git(ws, ["config", "user.name", "Wello Test"]);
  await writeFile(join(ws, "readme.md"), "line one\n");
  git(ws, ["add", "readme.md"]);
  git(ws, ["commit", "-m", "init"]);
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

    // «Вручную» is the mode that asks — which is the point here.
    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill("Замени в readme.md строку «line one» на «line two». Больше ничего не делай.");
    await page.keyboard.press("Enter");

    // The agent looks around first, so several cards can precede the edit. Every
    // card is answered; the one that CHANGES a file has to show what changes.
    const card = page.locator(".perm");
    let sawEditPreview = false;
    for (let i = 0; i < 8; i++) {
      await expect(card).toBeVisible({ timeout: 240_000 });
      const preview = card.locator(".perm__preview");
      if ((await preview.count()) > 0) {
        await expect(preview).toContainText("line two");
        sawEditPreview = true;
        await card.getByRole("button", { name: "Разрешить один раз" }).click();
        break;
      }
      await card.getByRole("button", { name: "Разрешить для задачи" }).click();
      await expect(card).toBeHidden({ timeout: 60_000 });
    }
    expect(sawEditPreview).toBe(true); // approving a write is never blind
    await expect
      .poll(async () => readFile(join(ws, "readme.md"), "utf8"), { timeout: 180_000 })
      .toContain("line two");

    // The review panel: a comment on one diff line becomes one follow-up turn.
    await page.getByRole("button", { name: "Проверка изменений" }).click();
    // NOT `.dl__comment`: hunk headers render a void placeholder with the same
    // class (aria-hidden, pointer-events off) — the real affordance is a button.
    const plus = page.locator("button.dl__comment").first();
    await expect(plus).toBeVisible({ timeout: 60_000 });
    await plus.click();
    await page.locator(".dcomment__field").fill("верни как было");
    await page.getByRole("button", { name: "Добавить" }).click();
    await expect(page.locator(".reviewbar")).toContainText("замечание", { timeout: 30_000 });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("Opus 5: the agent captures the preview pane and reads its console", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(360_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-o5-pv-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-o5-pv-ud-"));
  // A page with one unmistakable word on it and one console error, so the answer
  // can only come from actually looking at the pane.
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
    await connect(page);
    await trustProject(page);
    await useOpus5(page);
    await fullAccess(page);

    await page.locator('button[aria-label="Открыть превью"]').click();
    await expect(page.locator(".preview__addr")).toBeVisible({ timeout: 30_000 });

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
    ).toBeVisible({ timeout: 300_000 });
    await expect(page.locator(".msg", { hasText: "tool-result-image" })).toHaveCount(0);
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("Opus 5: the top of the effort scale still finishes its turn", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(420_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-o5-eff-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-o5-eff-ud-"));
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

    // «Максимум» — the position that runs on a bounded thinking budget instead of
    // raw effort, because raw effort here never stopped (see TOP_THINKING_BUDGET).
    // That guard was written while this model returned no thinking at all; it
    // reasons for real again now, so the bound is what keeps the turn finite.
    await page
      .getByRole("button", { name: /Opus 5/ })
      .first()
      .click();
    await page.locator('input[aria-label="Усилие модели"]').fill("4");
    await expect(page.locator(".effort__value")).toHaveText("Максимум");
    await page.keyboard.press("Escape");

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill("Сколько будет 17 умножить на 23? Ответь только числом.");
    await page.keyboard.press("Enter");

    // Terminates, with the right answer, and the status line lets go of the run.
    await expect(page.locator(".msg", { hasText: "391" }).first()).toBeVisible({
      timeout: 300_000,
    });
    await expect(page.getByRole("button", { name: "Остановить" })).toHaveCount(0, {
      timeout: 90_000,
    });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
