/**
 * Prompt history for the composer (terminal-style ↑/↓): pure helpers over the
 * tasks state. In an open chat the history is that chat's own sent prompts; on
 * the home screen it is the recent prompts across all chats (oldest → newest,
 * so ↑ walks back from the most recent).
 */

interface TaskLike {
  id: string;
  updatedAt?: string;
  agent: { startedAt: string | null; items: Array<{ kind: string; text?: string }> };
}

const HISTORY_CAP = 100;

function userTexts(task: TaskLike): string[] {
  const out: string[] = [];
  for (const item of task.agent.items) {
    if (item.kind !== "user") continue;
    const text = (item.text ?? "").trim();
    if (text) out.push(text);
  }
  return out;
}

function activityMs(task: TaskLike): number {
  const stamp = task.updatedAt ?? task.agent.startedAt;
  const ms = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** Oldest → newest list of prompts to walk with ↑ (capped, no adjacent dupes). */
export function collectPromptHistory(tasks: TaskLike[], activeId: string | null): string[] {
  const texts: string[] = [];
  if (activeId) {
    const task = tasks.find((t) => t.id === activeId);
    if (task) texts.push(...userTexts(task));
  } else {
    for (const task of [...tasks].sort((a, b) => activityMs(a) - activityMs(b))) {
      texts.push(...userTexts(task));
    }
  }
  const deduped: string[] = [];
  for (const t of texts) {
    if (deduped[deduped.length - 1] !== t) deduped.push(t);
  }
  return deduped.slice(-HISTORY_CAP);
}

/** ↑/↓ walk state: `index` into the history (null = not navigating), plus the
 *  draft that was in the field when navigation started (restored at the end). */
export interface HistoryNav {
  index: number | null;
  stash: string;
}

/** One ↑ step. Null when there is nothing to recall (history empty / at start). */
export function historyUp(
  history: string[],
  nav: HistoryNav,
  currentText: string,
): { nav: HistoryNav; text: string } | null {
  if (history.length === 0) return null;
  if (nav.index === null) {
    return { nav: { index: history.length - 1, stash: currentText }, text: history[history.length - 1]! };
  }
  if (nav.index <= 0) return null;
  const index = nav.index - 1;
  return { nav: { ...nav, index }, text: history[index]! };
}

/** One ↓ step; walking past the newest entry restores the stashed draft. */
export function historyDown(
  history: string[],
  nav: HistoryNav,
): { nav: HistoryNav; text: string } | null {
  if (nav.index === null) return null;
  if (nav.index >= history.length - 1) {
    return { nav: { index: null, stash: "" }, text: nav.stash };
  }
  const index = nav.index + 1;
  return { nav: { ...nav, index }, text: history[index]! };
}
