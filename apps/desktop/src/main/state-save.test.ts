import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// state-store.ts reads app.getPath('userData'); point it at a throwaway dir.
let userData = "";
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

import { saveDrafts, saveState, saveStats } from "./state-store";
import type { PersistedState } from "../shared/ipc-api";

beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), "wello-state-"));
});
afterAll(async () => {
  await rm(userData, { recursive: true, force: true });
});

const stateFile = (): string => join(userData, "wello-state.json");
const read = async (): Promise<PersistedState> =>
  JSON.parse(await readFile(stateFile(), "utf8")) as PersistedState;

/** A state whose size is dominated by the chat history, like a real one. */
function stateWith(tag: string, drafts: Record<string, string> = {}): PersistedState {
  return {
    version: 1,
    workspace: null,
    activeId: "t1",
    tasks: [{ id: "t1", tag, items: Array.from({ length: 50 }, (_, i) => `${tag}-${i}`) }],
    drafts,
  };
}

/** Lets the queued write drain (one microtask hop per queued state + fs I/O). */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 60));

describe("autosave never queues more than the newest state", () => {
  it("writes the LAST of a burst and drops the superseded ones", async () => {
    const before = saveStats().saves;
    saveState(stateWith("a"));
    saveState(stateWith("b"));
    saveState(stateWith("c"));
    saveState(stateWith("d"));
    await settle();

    const written = await read();
    expect((written.tasks[0] as { tag: string }).tag).toBe("d");
    // The point of the change: a burst of N saves is not N serialisations of the
    // whole history. The first one is already in flight, the rest collapse into
    // one — so a burst costs at most two writes, never four.
    expect(saveStats().saves - before).toBeLessThanOrEqual(2);
  });

  it("keeps the history when only the drafts are saved", async () => {
    saveState(stateWith("history", { "chat:1": "старый черновик" }));
    await settle();

    await saveDrafts({ "chat:1": "новый черновик", "chat:2": "второй" });
    await settle();

    const written = await read();
    // Typing must not be able to lose (or rewrite) the conversation.
    expect((written.tasks[0] as { tag: string }).tag).toBe("history");
    expect(written.drafts).toEqual({ "chat:1": "новый черновик", "chat:2": "второй" });
  });

  it("does not let drafts written mid-save push back the newer history", async () => {
    // The unlucky interleave: a full save is in flight (its tasks are NOT yet
    // recorded as "last written") when typing triggers a drafts-only save. If
    // the drafts merged into the older state, the turn that was being written
    // would be dropped from the file.
    saveState(stateWith("old"));
    await settle();
    saveState(stateWith("new")); // in flight, not yet recorded
    await saveDrafts({ "chat:1": "печатаю прямо сейчас" });
    await settle();

    const written = await read();
    expect((written.tasks[0] as { tag: string }).tag).toBe("new");
    expect(written.drafts).toEqual({ "chat:1": "печатаю прямо сейчас" });
  });

  it("reports what it wrote, so a slow-app report carries numbers", async () => {
    saveState(stateWith("measured"));
    await settle();
    const stats = saveStats();
    expect(stats.saves).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(100);
  });
});
