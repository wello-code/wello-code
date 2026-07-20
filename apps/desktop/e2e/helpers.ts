import type { ElectronApplication } from "@playwright/test";

/**
 * Close the app even when a run is still in flight: the close guard holds the
 * window and shows the «Идёт генерация» dialog — confirm «Прервать и выйти» to
 * finish. A clean idle close never shows the dialog and the click times out
 * silently. (The button was «Завершить и выйти» before the 3-way close dialog;
 * it is «Прервать и выйти» now.)
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const page = app.windows()[0];
  const closing = app.close();
  if (page) {
    await page
      .getByRole("button", { name: "Прервать и выйти" })
      .click({ timeout: 4_000 })
      .catch(() => {});
  }
  await closing;
}
