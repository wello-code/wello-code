import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * The rest of the unreleased work on a GPT model: the edit card's diff preview,
 * line comments on a diff, a task in a copy of the project, the support report,
 * and the picker's model health. Opt-in like the other live specs.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Войти по API-ключу" }).click();
  await page.getByPlaceholder("wlo_live_").fill(KEY!);
  await page.getByRole("button", { name: "Подключить" }).click();
}

async function useGpt(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ }).first().click();
  await page.getByRole("option", { name: /GPT Terra/ }).click();
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

test("GPT: an edit is approved with its diff in front of you, then commented on line by line", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(300_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-edit-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-edit-ud-"));
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
    await page.locator(".composer__project").click();
    await page.getByRole("button", { name: "Доверяю папке" }).click();
    await useGpt(page);

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
      await expect(card).toBeVisible({ timeout: 180_000 });
      const preview = card.locator(".perm__preview");
      if ((await preview.count()) > 0) {
        await expect(preview).toContainText("line two");
        sawEditPreview = true;
        await card.getByRole("button", { name: "Разрешить один раз" }).click();
        break;
      }
      await card.getByRole("button", { name: "Разрешить для задачи" }).click();
      await expect(card).toBeHidden({ timeout: 30_000 });
    }
    expect(sawEditPreview).toBe(true); // approving a write is never blind
    await expect
      .poll(async () => readFile(join(ws, "readme.md"), "utf8"), { timeout: 120_000 })
      .toContain("line two");

    // The review panel: a comment on one diff line becomes one follow-up turn.
    await page.getByRole("button", { name: "Проверка изменений" }).click();
    // NOT `.dl__comment`: hunk headers render a void placeholder with the same
    // class (aria-hidden, pointer-events off) — the real affordance is a button.
    const plus = page.locator("button.dl__comment").first();
    await expect(plus).toBeVisible({ timeout: 30_000 });
    await plus.click();
    await page.locator(".dcomment__field").fill("верни как было");
    await page.getByRole("button", { name: "Добавить" }).click();
    await expect(page.locator(".reviewbar")).toContainText("замечание", { timeout: 15_000 });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("a task can run in a copy of the project, and the support report writes a file", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(240_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-wt-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-wt-ud-"));
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
    await page.locator(".composer__project").click();
    await page.getByRole("button", { name: "Доверяю папке" }).click();
    await useGpt(page);

    // The picker says which models are down right now (three-valued: unknown is
    // not «down», so this only asserts the picker renders its health state).
    await page.getByRole("button", { name: /GPT Terra/ }).first().click();
    await expect(page.locator(".modelsel__menu")).toBeVisible();
    await page.keyboard.press("Escape");

    // A task in a copy of the project: its own git worktree on its own branch.
    await page.getByRole("switch", { name: /в копии проекта/ }).click();
    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill("Ответь одним словом: копия");
    await page.keyboard.press("Enter");
    await expect(page.locator(".chattitle__wt")).toBeVisible({ timeout: 180_000 });
    // The original working tree stays untouched — the copy is a separate branch.
    const branches = execFileSync("git", ["-C", ws, "worktree", "list"], { encoding: "utf8" });
    expect(branches).toContain("[wello/");

    // The support report: one file a person can attach to a ticket, with the
    // account key masked out of it. Explorer is stubbed so the run stays headless.
    await app.evaluate(async ({ shell }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (shell as any).showItemInFolder = () => {};
    });
    const reportPath = await page.evaluate(() => window.wello.supportReport());
    const report = await readFile(reportPath, "utf8");
    expect(report).toContain("Wello Code");
    expect(report).not.toContain(process.env.WELLO_TEST_KEY!);
    expect(report).not.toMatch(/wlo_live_[a-f0-9]{16}/);
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
