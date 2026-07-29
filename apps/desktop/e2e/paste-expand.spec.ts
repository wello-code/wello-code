import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeApp } from "./helpers";

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A long paste folds into a chip so the composer stays readable. A user asked to
 * be able to get that text back into the field (to edit it, to trim it), so the
 * chip carries an "expand" button. This checks the whole path: paste folds,
 * button unfolds into the textarea, chip disappears.
 */
test("a folded paste can be expanded back into the composer", async () => {
  const app = await electron.launch({ args: [appDir] });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

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
    const value = await composer.inputValue();
    expect(value.startsWith("посмотри лог\n"), "the typed text stays first").toBe(true);
    expect(value).toContain("line 24: adb shell dumpsys");
    // The caret sits at the end, so typing continues after the paste.
    const caret = await composer.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
    expect(caret).toBe(value.length);
  } finally {
    await closeApp(app);
  }
});
