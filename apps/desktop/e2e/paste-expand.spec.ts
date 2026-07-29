import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeApp } from "./helpers";

// The composer only exists behind a connected account, so this is opt-in like the
// other UI specs: it needs a real key, and it runs on its OWN user-data dir so a
// developer's real profile is never typed into.
const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEY = process.env.WELLO_TEST_KEY;

/**
 * A long paste folds into a chip so the composer stays readable. A user asked to
 * be able to get that text back into the field (to edit it, to trim it), so the
 * chip carries an "expand" button. This checks the whole path: paste folds,
 * button unfolds it into the textarea, chip disappears, caret lands at the end.
 */
test("a folded paste can be expanded back into the composer", async () => {
  test.skip(!KEY, "set WELLO_TEST_KEY to run (the composer needs a connected account)");
  test.setTimeout(120_000);

  const userData = await mkdtemp(join(tmpdir(), "wello-paste-ud-"));
  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "Войти по API-ключу" }).click();
    await page.getByPlaceholder("wlo_live_").fill(KEY!);
    await page.getByRole("button", { name: "Подключить" }).click();

    const composer = page.locator("textarea").first();
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    await composer.click();
    await composer.fill("посмотри лог");

    // A paste long enough to fold (the chip triggers past the line/char limits).
    const pasted = Array.from({ length: 24 }, (_, i) => `line ${i + 1}: adb shell dumpsys`).join("\n");
    await page.evaluate((text) => {
      const el = document.querySelector("textarea");
      if (!el) throw new Error("composer not found");
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    }, pasted);

    const chip = page.locator(".attachchip", { hasText: "Вставка" });
    await expect(chip, "a long paste folds into a chip").toBeVisible();
    // The typed text is untouched while the paste sits in the chip.
    await expect(composer).toHaveValue("посмотри лог");

    await chip.getByRole("button", { name: "Развернуть вставку в поле ввода" }).click();

    await expect(chip, "the chip is gone once expanded").toHaveCount(0);
    await expect(composer, "the paste lands in the field").toHaveValue(
      /^посмотри лог\n[\s\S]*line 24: adb shell dumpsys$/,
    );
    // The caret sits at the end, so typing continues after the pasted text rather
    // than in front of it. Polled: focus and selection land a tick after the value.
    await expect
      .poll(
        async () =>
          await composer.evaluate((el: HTMLTextAreaElement) => el.selectionStart === el.value.length),
        { message: "caret ends up after the pasted text" },
      )
      .toBe(true);
  } finally {
    await closeApp(app);
    await rm(userData, { recursive: true, force: true });
  }
});
