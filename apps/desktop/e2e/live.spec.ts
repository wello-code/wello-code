import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeApp } from "./helpers";

// Opt-in live test: exercises the full stack against api.wello.dev. Set WELLO_TEST_KEY
// (a wlo_live_ key with PAYG balance) to run it; skipped otherwise so CI stays offline.
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

test("connect, open a workspace, and run a live Ask task end-to-end", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY to run the live agent test");
  test.setTimeout(150_000);

  const ws = await mkdtemp(join(tmpdir(), "wello-live-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-live-ud-"));
  await writeFile(join(ws, "README.md"), "# Live Test Project\n\nA tiny project for the live agent test.\n");
  await writeFile(join(ws, "index.js"), "export const answer = 42;\n");

  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    // Stub the native folder picker to return our temp workspace.
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);

    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Connect with the Wello key (the account sign-in screen is the default now —
    // switch to the legacy key mode first).
    await page.getByRole("button", { name: "Войти по API-ключу" }).click();
    await page.getByPlaceholder("wlo_live_").fill(KEY!);
    await page.getByRole("button", { name: "Подключить" }).click();

    // Open the (stubbed) workspace via the project strip, then run a read-only Ask task.
    await page.locator(".composer__project").click();
    // A fresh install has never seen this folder — the trust question comes first.
    await page.getByRole("button", { name: "Доверяю папке" }).click();
    const shotHome = process.env.WELLO_TEST_SHOT;
    if (shotHome) await page.screenshot({ path: shotHome.replace(/\.png$/, "-home.png") });
    await page
      .getByPlaceholder("Спросите что угодно")
      .fill("List the files in this project and greet me in one short sentence.");
    await page.getByRole("button", { name: "Отправить" }).click();

    // Manual mode may pop a permission card for a Read. Approve it — checking
    // visibility FIRST (fast, non-blocking) so a bare click({ timeout }) on an
    // absent button never holds Playwright's single action queue and starves the
    // assertion (diagnosed 2026-07-18).
    let settled = false;
    const allower = (async () => {
      while (!settled) {
        if (await page.locator(".perm").isVisible().catch(() => false)) {
          await page.getByRole("button", { name: "Разрешить для задачи" }).click().catch(() => {});
        }
        await page.waitForTimeout(400).catch(() => {});
      }
    })();

    // The agent's streamed reply (rendered markdown) should mention the files it read.
    await expect(page.locator(".md").last()).toContainText(/readme|index\.js|hello|hi/i, {
      timeout: 120_000,
    });
    settled = true;
    await allower;

    // Optional visual proof (set WELLO_TEST_SHOT to a file path).
    const shot = process.env.WELLO_TEST_SHOT;
    if (shot) await page.screenshot({ path: shot });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
