import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { closeApp, solidPng } from "./helpers";

/**
 * The two things that break without anything looking broken: an image a PERSON
 * attached, and the size of the window the context gauge divides by. Both fail
 * quietly — the model says the picture did not arrive, or the ring reports room
 * that is not there — so both are asserted against numbers rather than against
 * the app merely rendering something.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;
/** 128×128 of one unmistakable colour, generated so the bytes are provably intact. */
const PNG_RED = solidPng(128, [220, 20, 20]).toString("base64");

async function connect(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Войти по API-ключу" }).click();
  await page.getByPlaceholder("wlo_live_").fill(KEY!);
  await page.getByRole("button", { name: "Подключить" }).click();
}

async function useOpus5(page: Page): Promise<void> {
  await page
    .getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ })
    .first()
    .click();
  await page.getByRole("option", { name: /Opus 5/ }).click();
  await expect(page.getByRole("button", { name: /Opus 5/ }).first()).toBeVisible();
}

async function trustProject(page: Page): Promise<void> {
  await page.locator(".composer__project").click();
  await page.getByRole("button", { name: "Доверяю папке" }).click();
}

test("Opus 5: an image pasted by hand reaches the model", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(300_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-o5-paste-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-o5-paste-ud-"));
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

    // Paste the picture the way a person does: a clipboard event carrying a file.
    const composer = page.getByPlaceholder(/Спросите/).first();
    await composer.click();
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], "shot.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const el = document.querySelector("textarea")!;
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, PNG_RED);

    // It becomes an attachment chip, not silently dropped text.
    await expect(page.locator(".attachchip")).toHaveCount(1, { timeout: 15_000 });

    await composer.fill("Какого цвета картинка? Ответь одним словом.");
    await page.keyboard.press("Enter");

    // The answer can only come from having seen it. A stripped image reads as
    // «изображение не прикрепилось», which this assertion fails on.
    await expect(page.locator(".msg", { hasText: /красн/i }).first()).toBeVisible({
      timeout: 240_000,
    });
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test("Opus 5: the context gauge divides by the million-token window, not by 200K", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY");
  test.setTimeout(300_000);
  const ws = await mkdtemp(join(tmpdir(), "wello-o5-win-ws-"));
  const userData = await mkdtemp(join(tmpdir(), "wello-o5-win-ud-"));
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

    await page.getByPlaceholder(/Спросите/).first().fill("Ответь одним словом: привет");
    await page.keyboard.press("Enter");
    await expect(page.locator(".ctx__ring")).toBeVisible({ timeout: 240_000 });
    await page.locator(".ctx__ring").click();

    // The window is what «свободно» is measured against. This model is served
    // with its native million-token window — a probe put 313K through it — so a
    // gauge reading a 200K table would understate the room by five times and
    // start warning people to split a task that has barely begun.
    const meta = await page.locator(".ctx__meta").innerText();
    const free = /(\d+)\D*свободно/.exec(meta);
    expect(free, `context meta should report free tokens, got: ${meta}`).not.toBeNull();
    expect(Number(free![1]), `free tokens (thousands) from: ${meta}`).toBeGreaterThan(500);
  } finally {
    await closeApp(app);
    await rm(ws, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});
