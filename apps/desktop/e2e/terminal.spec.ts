import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * The terminal, from both ends.
 *
 * Reported 2026-08-08: «с терминалом стала огромная проблема — модели теперь
 * просят меня git commit сделать». Asking the person to run a command IS the
 * symptom of an agent that cannot run one: blocked from the shell, the model
 * hands the work back in prose. So the assertion is not «a command ran» but
 * «the work happened» — a commit exists in the log — plus the panel a person
 * types into themselves, which is the other half of the same complaint.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });
}

async function repo(prefix: string): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), `wello-${prefix}-ws-`));
  git(ws, ["init"]);
  git(ws, ["config", "user.email", "test@wello.dev"]);
  git(ws, ["config", "user.name", "Wello Test"]);
  git(ws, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(ws, "readme.md"), "# project\n");
  git(ws, ["add", "readme.md"]);
  git(ws, ["commit", "-m", "init"]);
  // An uncommitted change, so there is something to commit.
  await writeFile(join(ws, "readme.md"), "# project\n\nвторая строка\n");
  return ws;
}

async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Войти по API-ключу" }).click();
  await page.getByPlaceholder("wlo_live_").fill(KEY!);
  await page.getByRole("button", { name: "Подключить" }).click();
  await page.locator(".composer__project").click();
  await page.getByRole("button", { name: "Доверяю папке" }).click();
}

async function setMode(page: Page, option: RegExp, confirm = false): Promise<void> {
  await page.getByRole("button", { name: "Вручную" }).click();
  await page.getByRole("option", { name: option }).click();
  if (confirm) await page.getByRole("button", { name: "Понимаю, включить" }).click();
}

test("the agent commits by itself instead of asking the person to do it", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(480_000);
  const ws = await repo("commit-auto");
  const userData = await mkdtemp(join(tmpdir(), "wello-commit-auto-ud-"));
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await connect(page);
    // «Авто» is the mode people run unattended, and the mode the complaint came
    // from: there the shell decision is made without asking anyone.
    await setMode(page, /Авто/);

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill("Закоммить текущие изменения в git с сообщением «правка из теста». Сам, без меня.");
    await page.keyboard.press("Enter");

    // The commit is the proof. Prose that asks the person to run it themselves
    // leaves the log untouched, which is exactly what the report described.
    await expect
      .poll(() => git(ws, ["log", "--oneline"]), { timeout: 420_000 })
      .toMatch(/правка из теста/);
    await expect(page.getByRole("button", { name: "Остановить" })).toHaveCount(0, {
      timeout: 120_000,
    });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("in «Вручную» the commit is asked for on a card, then made", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(480_000);
  const ws = await repo("commit-manual");
  const userData = await mkdtemp(join(tmpdir(), "wello-commit-manual-ud-"));
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await connect(page);

    await page
      .getByPlaceholder(/Спросите/)
      .first()
      .fill("Закоммить текущие изменения в git с сообщением «правка из теста». Сам, без меня.");
    await page.keyboard.press("Enter");

    // Approve whatever it asks for; a card is the honest behaviour of this mode.
    const card = page.locator(".perm");
    for (let i = 0; i < 8; i++) {
      const asked = await card
        .waitFor({ state: "visible", timeout: 90_000 })
        .then(() => true)
        .catch(() => false);
      if (!asked) break;
      await card.getByRole("button", { name: "Разрешить для задачи" }).click();
      await expect(card).toBeHidden({ timeout: 60_000 });
      if (/правка из теста/.test(git(ws, ["log", "--oneline"]))) break;
    }
    await expect
      .poll(() => git(ws, ["log", "--oneline"]), { timeout: 300_000 })
      .toMatch(/правка из теста/);
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("the terminal panel runs what a person types into it", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(240_000);
  const ws = await repo("term-panel");
  const userData = await mkdtemp(join(tmpdir(), "wello-term-ud-"));
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await connect(page);

    await page.locator('button[aria-label="Открыть терминал"]').click();
    const field = page.locator(".terminal__field");
    await expect(field).toBeVisible({ timeout: 30_000 });

    // A shell of our own, in the project folder, printing something only this
    // command could print.
    await field.fill("node -e \"console.log('ТЕРМИНАЛ-ЖИВ')\"");
    await page.keyboard.press("Enter");
    await expect(page.locator(".termout")).toContainText("ТЕРМИНАЛ-ЖИВ", { timeout: 90_000 });

    // And it is a live session, not a one-shot: a second command still runs.
    await field.fill("node -e \"console.log(6*7)\"");
    await page.keyboard.press("Enter");
    await expect(page.locator(".termout")).toContainText("42", { timeout: 90_000 });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("the terminal shows Cyrillic output as text, not as mojibake", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(240_000);
  const ws = await repo("term-enc");
  const userData = await mkdtemp(join(tmpdir(), "wello-term-enc-ud-"));
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await connect(page);
    await page.locator('button[aria-label="Открыть терминал"]').click();
    const field = page.locator(".terminal__field");
    await expect(field).toBeVisible({ timeout: 30_000 });

    // Most of this app's users are on Windows and write Russian. A console that
    // hands back «ïðèâåò» is the shape of «с терминалом огромная проблема», and
    // it is a decoding bug on our side, not something the model can work around.
    await field.fill("node -e \"console.log('ПРИВЕТ-ТЕРМИНАЛ')\"");
    await page.keyboard.press("Enter");
    await expect(page.locator(".termout")).toContainText("ПРИВЕТ-ТЕРМИНАЛ", { timeout: 90_000 });
    // And the reverse: no mojibake anywhere in what came back.
    await expect(page.locator(".termout")).not.toContainText("Ï");
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
