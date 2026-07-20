import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * Live check of the GitHub-for-novices flow: on "publish this to GitHub" with
 * GitHub NOT connected, the model must reach for the github_connect tool — the
 * chat shows the one-click connect card — and must NEVER route the user to
 * `gh auth login` / github.com/new (the exact trap this feature removes).
 * Declining the card is the CI-safe path (a real Device Flow needs a browser);
 * the run must then finish gracefully, still without terminal instructions.
 * Opt-in like live.spec: skipped without WELLO_TEST_KEY.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

test("live: «выложи на GitHub» → connect card in the chat, never gh auth login", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(420_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-gh-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-gh-ud-"));
  await writeFile(join(ws, "index.html"), "<!doctype html><title>Mafin</title><h1>Кофейня Mafin</h1>\n");
  await writeFile(join(ws, "README.md"), "# Mafin landing\n");

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

    // Auto mode: file reads / commands run unattended — the only card that may
    // appear is the GitHub connect card itself.
    await page.locator(".composer__left .modelsel__button").first().click();
    await page.locator(".modelsel__item", { hasText: "Авто" }).first().click();

    await page
      .getByPlaceholder("Спросите что угодно")
      .fill("Выложи этот проект на GitHub в приватный репозиторий.");
    await page.getByRole("button", { name: "Отправить" }).click();

    // The model must surface OUR connect card (github_connect), not terminal advice.
    await expect(page.locator("#ghconnect-title")).toBeVisible({ timeout: 240_000 });
    const shot = process.env.WELLO_TEST_SHOT;
    if (shot) await page.screenshot({ path: shot });

    // CI-safe branch: decline. The run must finish and still never point the
    // user at gh auth login / manual github.com repo creation.
    await page.getByRole("button", { name: "Отклонить" }).click();
    await expect(page.getByRole("button", { name: "Отправить" })).toBeVisible({ timeout: 150_000 });
    const answers = await page.locator(".md").allInnerTexts();
    const finalText = answers.join("\n");
    expect(finalText).not.toMatch(/gh auth login/i);
    expect(finalText).not.toMatch(/github\.com\/new/i);
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true }).catch(() => undefined);
    await rm(userData, { recursive: true, force: true }).catch(() => undefined);
  }
});
