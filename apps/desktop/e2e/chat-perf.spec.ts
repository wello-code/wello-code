import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { closeApp } from "./helpers";

/**
 * A long conversation must stay responsive.
 *
 * The bug this pins: with ~20 messages on screen the window went "(Не отвечает)"
 * while an answer streamed. Every state change re-rendered the whole thread —
 * markdown re-parsed and code re-highlighted for every earlier message — and a
 * streaming reply changes state dozens of times a second.
 *
 * Typing in the composer drives the SAME full re-render as a stream chunk, and
 * needs no agent run, so that is what this measures. Numbers from this harness
 * on the fix's own machine:
 *
 *   thread      before      after
 *   empty       1.9 ms      1.8 ms
 *   26 messages 38.2 ms     2.1 ms
 *
 * — i.e. the conversation itself used to cost 36 ms of main thread per keystroke
 * and now costs a third of a millisecond.
 */

const appDir = join(dirname(fileURLToPath(import.meta.url)), "..");

/** ~10 KB of markdown with two fenced code blocks — a realistic agent answer. */
const ANSWER = `Готово. Разобрал, что происходило, и поправил обе стороны.

Причина была в том, что состояние пересоздавалось на каждом кадре, поэтому
подсветка кода пересчитывалась заново для всей ленты.

\`\`\`ts
export function highlight(code: string, lang: string | null): string | null {
  if (!lang) return null;
  const key = \`\${lang} \${code}\`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  cache.set(key, html);
  return html;
}
\`\`\`

Проверил на реальном проекте: время отклика вернулось к норме.

\`\`\`bash
pnpm --filter @wello-code/desktop test:e2e
pnpm test
\`\`\`

Дальше по списку — панель изменений и откат хода.`;

function makeState(messages: number): unknown {
  const items: unknown[] = [];
  for (let i = 0; i < messages; i += 2) {
    items.push({
      kind: "user",
      id: `u${i}`,
      text: `Шаг ${i / 2 + 1}: посмотри, почему тут тормозит, и покажи код.`,
      runId: `run-${i}`,
    });
    items.push({ kind: "message", id: `m${i}`, text: ANSWER, done: true });
  }
  return {
    version: 1,
    workspace: null,
    activeId: "perf-task",
    tasks: [
      {
        id: "perf-task",
        title: "Длинная переписка",
        prompt: "",
        mode: "code",
        runId: null,
        sessionId: null,
        workspacePath: null,
        pinned: false,
        updatedAt: new Date(0).toISOString(),
        agent: {
          items,
          running: false,
          elapsedMs: 1234,
          startedAt: null,
          subagents: [],
          plan: null,
        },
        changes: null,
      },
    ],
  };
}

const KEY = process.env.WELLO_TEST_KEY;

test("a 26-message thread still answers the keyboard", async () => {
  // Opt-in like the other live specs: with no key the app opens on the sign-in
  // screen and there is no thread to measure.
  test.skip(!KEY, "set WELLO_TEST_KEY to run (the chat is behind sign-in)");
  test.setTimeout(120_000);
  const userData = await mkdtemp(join(tmpdir(), "wello-perf-ud-"));
  await writeFile(join(userData, "wello-state.json"), JSON.stringify(makeState(26)), "utf8");

  const app = await electron.launch({ args: [appDir, `--user-data-dir=${userData}`] });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Sign in with the key (the browser flow is the default screen). Nothing in
    // this test runs the agent — the key only gets us past the door.
    await page.getByRole("button", { name: "Войти по API-ключу" }).click();
    await page.getByPlaceholder("wlo_live_").fill(KEY!);
    await page.getByRole("button", { name: "Подключить" }).click();

    // The thread is restored from disk: wait until its messages are on screen.
    await expect(page.locator(".msg").first()).toBeVisible({ timeout: 30_000 });
    expect(await page.locator(".msg").count()).toBe(13);

    const composer = page.locator("textarea").first();
    await composer.click();

    // Warm-up: the first keystroke also pays for focus and any lazy work.
    await page.keyboard.type("ab");
    await page.waitForTimeout(200);

    // 30 keystrokes, each forcing the same top-down re-render a stream chunk does.
    //
    // The clock brackets the dispatch ITSELF, not the gap between frames: `input`
    // is a discrete event, so React flushes the re-render synchronously before
    // dispatchEvent returns. Timing across requestAnimationFrame instead would
    // measure the frame interval (~33 ms in a background window) and report the
    // same number no matter how much work the app does — which is exactly the
    // wrong answer this test existed to give at first.
    const perKey = await page.evaluate(async () => {
      const el = document.querySelector("textarea");
      if (!el) throw new Error("composer not found");
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
      let busy = 0;
      for (let i = 0; i < 30; i++) {
        const t0 = performance.now();
        setValue.call(el, `${el.value}x`);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        busy += performance.now() - t0;
        // Let the frame paint between keystrokes, outside the measured window.
        await frame();
      }
      return busy / 30;
    });

    console.log(`перерисовка на нажатие клавиши: ${perKey.toFixed(1)} мс`);
    // Measured on this machine, same thread, same harness: 38.2 ms before the
    // memoization + highlight cache, 2.1 ms after. An empty thread costs 1.8 ms
    // either way — the thread itself is what used to be expensive. 12 ms leaves
    // a slow CI box six times the current cost and still fails outright if the
    // per-message work comes back.
    expect(perKey).toBeLessThan(12);
  } finally {
    await closeApp(app);
    await rm(userData, { recursive: true, force: true });
  }
});
