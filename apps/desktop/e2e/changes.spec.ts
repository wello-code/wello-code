import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";

// Deterministic review-flow test (no agent run): a git repo with one uncommitted
// edit. Connect still needs a real key, so this is opt-in like the live test.
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

test("review changes: list a modified file, show its diff, and revert it", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY to run (connect needs a real key)");
  test.setTimeout(120_000);

  const ws = await mkdtemp(join(tmpdir(), "wello-chg-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-chg-ud-"));
  const g = (args: string[]): void => {
    execFileSync("git", ["-C", ws, ...args], { stdio: "pipe" });
  };
  g(["init"]);
  g(["config", "user.email", "test@wello.dev"]);
  g(["config", "user.name", "Wello Test"]);
  await writeFile(join(ws, "README.md"), "line one\n");
  g(["add", "README.md"]);
  g(["commit", "-m", "init"]);
  await writeFile(join(ws, "README.md"), "line one\nline two added\n");

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
    // A fresh install has never seen this folder — answer the trust question.
    await page.getByRole("button", { name: "Доверяю папке" }).click();

    await page.getByRole("button", { name: "Проверка изменений" }).click();
    await expect(page.locator(".filelist__path")).toContainText("README.md", { timeout: 15_000 });

    // The first file is auto-selected; its diff shows the added line with a gutter number.
    await expect(page.locator(".dl--add .dl__text")).toContainText("line two added", { timeout: 10_000 });

    const shot = process.env.WELLO_TEST_SHOT;
    if (shot) await page.screenshot({ path: shot });

    // Reverting is destructive, so it now takes two clicks: arm, then confirm.
    await page.getByRole("button", { name: "Откатить README.md" }).click();
    await page.getByRole("button", { name: "Подтвердить: откатить README.md" }).click();
    await expect(page.locator(".filelist__item")).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await app.close();
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
