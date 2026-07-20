import { describe, expect, it } from "vitest";
import { collectPromptHistory, historyDown, historyUp, type HistoryNav } from "./prompt-history";

function task(id: string, updatedAt: string, prompts: string[]) {
  return {
    id,
    updatedAt,
    agent: {
      startedAt: null,
      items: prompts.map((text) => ({ kind: "user", text })),
    },
  };
}

describe("collectPromptHistory", () => {
  it("uses only the active chat's prompts when a chat is open", () => {
    const tasks = [
      task("a", "2026-07-01T10:00:00Z", ["first a", "second a"]),
      task("b", "2026-07-02T10:00:00Z", ["first b"]),
    ];
    expect(collectPromptHistory(tasks, "a")).toEqual(["first a", "second a"]);
  });

  it("merges all chats oldest→newest on the home screen", () => {
    const tasks = [
      task("new", "2026-07-02T10:00:00Z", ["newer"]),
      task("old", "2026-07-01T10:00:00Z", ["older"]),
    ];
    expect(collectPromptHistory(tasks, null)).toEqual(["older", "newer"]);
  });

  it("drops empty texts and adjacent duplicates", () => {
    const tasks = [task("a", "2026-07-01T10:00:00Z", ["x", "  ", "x", "y", "x"])];
    expect(collectPromptHistory(tasks, "a")).toEqual(["x", "y", "x"]);
  });
});

describe("historyUp / historyDown", () => {
  const history = ["one", "two", "three"];

  it("↑ starts from the newest and stashes the draft", () => {
    const step = historyUp(history, { index: null, stash: "" }, "my draft");
    expect(step).toEqual({ nav: { index: 2, stash: "my draft" }, text: "three" });
  });

  it("↑ walks back and stops at the oldest", () => {
    let nav: HistoryNav = { index: null, stash: "" };
    nav = historyUp(history, nav, "")!.nav;
    nav = historyUp(history, nav, "three")!.nav;
    nav = historyUp(history, nav, "two")!.nav;
    expect(nav.index).toBe(0);
    expect(historyUp(history, nav, "one")).toBeNull();
  });

  it("↓ walks forward and finally restores the stash", () => {
    const nav: HistoryNav = { index: 1, stash: "draft" };
    const fwd = historyDown(history, nav)!;
    expect(fwd.text).toBe("three");
    const done = historyDown(history, fwd.nav)!;
    expect(done).toEqual({ nav: { index: null, stash: "" }, text: "draft" });
    expect(historyDown(history, done.nav)).toBeNull();
  });

  it("↑ with an empty history does nothing", () => {
    expect(historyUp([], { index: null, stash: "" }, "text")).toBeNull();
  });
});
