import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * Live checks of the 2026-07-18 feature marathon — workspace trust, restricted
 * mode locks, CLAUDE.md pickup through the real engine, prompt history, the
 * plan widget (the engine's Task* registry), editing an earlier turn (session
 * fork at resumeSessionAt) and the gateway-backed web search. Opt-in like
 * live.spec: skipped without WELLO_TEST_KEY; the search leg additionally needs
 * WELLO_TEST_WEBSEARCH=1 (a deployed gateway with Parallel keys).
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Войти по API-ключу" }).click();
  await page.getByPlaceholder("wlo_live_").fill(KEY!);
  await page.getByRole("button", { name: "Подключить" }).click();
}

test("restricted mode: trust declined → locks; chip flips the decision", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(120_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-feat-a-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-feat-a-ud-"));
  await writeFile(join(ws, "CLAUDE.md"), "# Instructions\n\nProject codename: ZEBRA-777.\n");
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    await app.evaluate(async ({ dialog }, wsPath) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [wsPath] });
    }, ws);
    const page = await app.firstWindow();
    await connect(page);
    await page.locator(".composer__project").click();

    // The trust question appears for a never-seen folder; decline it.
    await expect(page.getByRole("button", { name: "Ограниченный режим" })).toBeVisible();
    await page.getByRole("button", { name: "Ограниченный режим" }).click();

    // The restricted chip shows; the instructions chip is muted (not honored).
    await expect(page.locator(".wschip--warn")).toContainText("Ограниченный режим");
    await expect(page.locator(".wschip.is-muted")).toContainText("CLAUDE.md");

    // Unattended modes are locked in the mode menu.
    await page.locator(".composer__left .modelsel__button").first().click();
    const auto = page.locator(".modelsel__item", { hasText: "Требует доверия папке" });
    await expect(auto.first()).toBeDisabled();
    await page.keyboard.press("Escape");

    // The chip re-opens the question; trusting clears the locks.
    await page.locator(".wschip--warn").click();
    await page.getByRole("button", { name: "Доверяю папке" }).click();
    await expect(page.locator(".wschip--warn")).toHaveCount(0);
    await expect(page.locator(".wschip.is-muted")).toHaveCount(0);
    await expect(page.locator(".wschip", { hasText: "CLAUDE.md" })).toBeVisible();
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("live: CLAUDE.md pickup, plan widget, prompt history, edit-a-turn fork, web search", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(600_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-feat-b-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-feat-b-ud-"));
  await writeFile(
    join(ws, "CLAUDE.md"),
    "# Project instructions\n\nThis project's internal build profile is named ZEBRA-777 " +
      "(use this name in configs and when asked about the build profile).\n",
  );
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

    // Auto mode (folder is trusted now) — fewer permission cards for the runs.
    await page.locator(".composer__left .modelsel__button").first().click();
    await page.locator(".modelsel__item", { hasText: "Авто" }).first().click();

    // Turn 1 — the engine must see CLAUDE.md via settingSources (no tools).
    const composer = page.getByPlaceholder("Спросите что угодно");
    await composer.fill(
      "What is this project's build profile named, per the project instructions? Answer with just the name. Do not use any tools.",
    );
    await page.getByRole("button", { name: "Отправить" }).click();
    await expect(page.locator(".md").last()).toContainText(/ZEBRA-777/i, { timeout: 150_000 });

    // Prompt history: ↑ in the empty composer recalls the sent prompt; Esc restores.
    const followup = page.getByPlaceholder("Запросите внесение дополнительных изменений");
    await followup.click();
    await page.keyboard.press("ArrowUp");
    await expect(followup).toHaveValue(/build profile/i);
    await page.keyboard.press("Escape");
    await expect(followup).toHaveValue("");

    // Turn 2 — TodoWrite feeds the plan widget.
    await followup.fill(
      "Create a todo list with exactly 3 items using TodoWrite (plan: name three colors), then complete them one by one and answer with the three colors.",
    );
    await page.getByRole("button", { name: "Отправить" }).click();
    await expect(page.locator(".planw")).toBeVisible({ timeout: 150_000 });
    await expect(page.locator(".planw__count")).toContainText("/3", { timeout: 150_000 });
    // Wait for the run to settle (the send button returns).
    await expect(page.getByRole("button", { name: "Отправить" })).toBeVisible({ timeout: 150_000 });

    // Edit turn 2: the timeline truncates and the fork answers the corrected ask.
    const bubbles = page.locator(".usermsg");
    await expect(bubbles).toHaveCount(2);
    await bubbles.nth(1).hover();
    await bubbles.nth(1).getByRole("button", { name: "Редактировать сообщение" }).click({ force: true });
    await expect(page.locator(".editnote")).toBeVisible();
    await followup.fill(
      "Ignore earlier asks. What is the project's build profile named? Prefix your answer with EDITED:",
    );
    await page.getByRole("button", { name: "Отправить" }).click();
    await expect(page.locator(".md").last()).toContainText(/EDITED:.*ZEBRA-777/is, {
      timeout: 150_000,
    });
    // The pre-edit second turn (colors) is gone from the timeline.
    await expect(page.locator(".usermsg")).toHaveCount(2);
    await expect(page.locator(".usermsg").nth(1)).toContainText(/EDITED|codename/i);

    // Web search through the gateway tool (skipped gracefully if not deployed).
    if (process.env.WELLO_TEST_WEBSEARCH === "1") {
      await followup.fill(
        "Use the web_search tool right now to find the latest stable Node.js LTS version, then answer in one sentence citing a source URL.",
      );
      await page.getByRole("button", { name: "Отправить" }).click();
      // Periscope loop: allow any permission card, log what the screen shows
      // every 15s, succeed as soon as the search step ran and an answer landed.
      let searched = false;
      for (let i = 0; i < 10 && !searched; i++) {
        await page
          .getByRole("button", { name: "Разрешить для задачи" })
          .click({ timeout: 1_000 })
          .catch(() => {});
        await page.waitForTimeout(14_000).catch(() => {});
        const step = await page
          .locator(".tool__summary", { hasText: "Поиск в интернете" })
          .count();
        const status = await page.locator(".runstatus__label").allTextContents().catch(() => []);
        const perm = await page.locator(".perm").textContent().catch(() => null);
        const lastMd = (await page.locator(".md").last().textContent().catch(() => "")) ?? "";
        console.log(
          `[search t+${(i + 1) * 15}s] step=${step} status=${JSON.stringify(status)} perm=${JSON.stringify(
            (perm ?? "").slice(0, 120),
          )} lastMd=${JSON.stringify(lastMd.slice(0, 140))}`,
        );
        searched = step > 0 && /node/i.test(lastMd) && lastMd !== "";
      }
      expect(searched).toBe(true);
    }
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
