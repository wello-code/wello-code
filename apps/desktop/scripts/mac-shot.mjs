/**
 * Launch the freshly built macOS app and photograph its window.
 *
 * This exists because the riskiest part of macOS support is invisible to every
 * other check: macOS draws its three traffic lights INSIDE our frameless title
 * bar, on the left, where the sidebar/search/navigation cluster lives. Whether
 * the reserved inset is right cannot be typechecked or unit-tested — someone has
 * to look. Nobody on the team runs macOS day to day, so CI looks on our behalf
 * and uploads the picture.
 *
 * Usage: node scripts/mac-shot.mjs <path-to-.app> <output.png>
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { basename } from "node:path";
import { _electron as electron } from "@playwright/test";

const [, , appPath, outPath] = process.argv;
if (!appPath || !outPath) {
  console.error("usage: node scripts/mac-shot.mjs <path-to-.app> <output.png>");
  process.exit(2);
}

// Inside a bundle the real binary is Contents/MacOS/<name without .app>.
const executablePath = join(appPath, "Contents", "MacOS", basename(appPath).replace(/\.app$/, ""));

const profile = await mkdtemp(join(tmpdir(), "wello-shot-"));
const app = await electron.launch({
  executablePath,
  args: [`--user-data-dir=${profile}`],
});

try {
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  // Let the shell settle so the title bar is laid out, not mid-mount.
  await page.waitForTimeout(2500);

  // What the inset is actually worth, in numbers, next to the picture.
  const bar = await page.evaluate(() => {
    const el = document.querySelector(".titlebar");
    if (!el) return null;
    const cs = getComputedStyle(el);
    const first = el.querySelector("button");
    return {
      paddingLeft: cs.paddingLeft,
      height: cs.height,
      platformAttr: document.documentElement.dataset.platform,
      firstControlLeft: first ? Math.round(first.getBoundingClientRect().left) : null,
    };
  });
  console.log("titlebar:", JSON.stringify(bar));
  if (bar && bar.firstControlLeft !== null && bar.firstControlLeft < 70) {
    console.warn(
      `WARNING: the first control starts at ${bar.firstControlLeft}px — the traffic lights ` +
        `occupy roughly the first 65px, so they are probably overlapping it.`,
    );
  }

  await page.screenshot({ path: outPath });
  console.log(`screenshot: ${outPath}`);
} finally {
  await app.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
