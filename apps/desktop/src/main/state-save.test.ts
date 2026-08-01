import { mkdtempSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// state-store.ts reads app.getPath('userData'); point it at a throwaway dir.
let userData = "";
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

import { loadState, saveDrafts, saveState, savesSettled, saveStats } from "./state-store";
import type { StateSavePayload } from "../shared/ipc-api";

beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), "wello-state-"));
});
afterAll(async () => {
  await rm(userData, { recursive: true, force: true });
});

const indexFile = (): string => join(userData, "wello-state.json");
const chatFile = (id: string): string => join(userData, "chats", `${id}.json`);
const readJson = async (p: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;

/** A chat whose weight is its timeline, like a real one. */
function chat(id: string, tag: string): Record<string, unknown> {
  return { id, title: `Чат ${id}`, tag, agent: { items: Array.from({ length: 40 }, (_, i) => `${tag}-${i}`) } };
}
function payload(chats: Record<string, unknown>[], changed?: Record<string, unknown>[]): StateSavePayload {
  return {
    workspace: null,
    activeId: chats[0] ? (chats[0].id as string) : null,
    taskIds: chats.map((c) => c.id as string),
    changed: changed ?? chats,
  };
}

/** Waits for the queued write to actually drain. NOT a sleep: a fixed delay
 *  passes on an idle machine and fails on a busy one, which is exactly the kind
 *  of test that gets ignored when it goes red. */
const settle = (): Promise<void> => savesSettled();

describe("history is stored per chat, not as one file", () => {
  it("writes one file per chat plus a small index", async () => {
    saveState(payload([chat("a", "one"), chat("b", "two")]));
    await settle();

    const index = await readJson(indexFile());
    expect(index.version).toBe(2);
    expect(index.taskIds).toEqual(["a", "b"]);
    // The index must stay small — it is the thing read on every launch.
    expect(JSON.stringify(index).length).toBeLessThan(300);
    expect((await readJson(chatFile("a"))).tag).toBe("one");
    expect((await readJson(chatFile("b"))).tag).toBe("two");
  });

  it("writes ONLY the chat that changed", async () => {
    const a = chat("a", "one");
    const b = chat("b", "two");
    saveState(payload([a, b], []));
    await settle();

    const before = saveStats().bytes;
    const bEdited = chat("b", "edited");
    saveState(payload([a, bEdited], [bEdited]));
    await settle();

    expect((await readJson(chatFile("b"))).tag).toBe("edited");
    expect((await readJson(chatFile("a"))).tag).toBe("one"); // untouched
    // The whole point: a turn in one chat costs that chat, not the archive.
    expect(saveStats().bytes).toBeLessThan(before + JSON.stringify(bEdited).length + 300);
  });

  it("restores chats in the index's order, with drafts from their own file", async () => {
    saveState(payload([chat("a", "one"), chat("b", "two")]));
    await settle();
    await saveDrafts({ "chat:a": "черновик" });

    const restored = await loadState();
    expect(restored?.tasks.map((t) => (t as { tag: string }).tag)).toEqual(["one", "two"]);
    expect(restored?.drafts).toEqual({ "chat:a": "черновик" });
    expect(restored?.legacy).toBeFalsy();
  });

  it("drops the files of chats the user deleted", async () => {
    saveState(payload([chat("a", "one"), chat("b", "two")]));
    await settle();
    saveState(payload([chat("a", "one")], []));
    await settle();

    const files = await readdir(join(userData, "chats"));
    expect(files).toEqual(["a.json"]);
  });

  it("still restores a state file written by the old single-file build", async () => {
    await rm(join(userData, "chats"), { recursive: true, force: true });
    await writeFile(
      indexFile(),
      JSON.stringify({
        version: 1,
        workspace: null,
        activeId: "old",
        tasks: [{ id: "old", tag: "наследие" }],
        drafts: { "chat:old": "старый черновик" },
      }),
      "utf8",
    );
    await rm(join(userData, "wello-drafts.json"), { force: true });

    const restored = await loadState();
    expect(restored?.tasks).toEqual([{ id: "old", tag: "наследие" }]);
    expect(restored?.drafts).toEqual({ "chat:old": "старый черновик" });
    // Flagged, so the renderer rewrites every chat once into the new layout.
    expect(restored?.legacy).toBe(true);
  });

  it("keeps a state file it cannot understand instead of dropping it", async () => {
    await writeFile(indexFile(), "{ this is not json", "utf8");
    expect(await loadState()).toBeNull();
    const files = await readdir(userData);
    expect(files.some((f) => f.endsWith(".corrupt.bak"))).toBe(true);
  });
});

describe("autosave never queues more than the newest payload", () => {
  it("writes the LAST of a burst and drops the superseded ones", async () => {
    await rm(indexFile(), { force: true });
    const before = saveStats().saves;
    saveState(payload([chat("a", "v1")]));
    saveState(payload([chat("a", "v2")]));
    saveState(payload([chat("a", "v3")]));
    saveState(payload([chat("a", "v4")]));
    await settle();

    expect((await readJson(chatFile("a"))).tag).toBe("v4");
    // A burst of four costs at most two writes: one in flight, one coalesced.
    expect(saveStats().saves - before).toBeLessThanOrEqual(2);
  });

  it("ignores a chat id that could escape the chats folder", async () => {
    saveState({
      workspace: null,
      activeId: null,
      taskIds: ["../../evil", "ok"],
      changed: [{ id: "../../evil", tag: "no" }, { id: "ok", tag: "yes" }],
    });
    await settle();

    const index = await readJson(indexFile());
    expect(index.taskIds).toEqual(["ok"]);
    const files = await readdir(join(userData, "chats"));
    expect(files).toEqual(["ok.json"]);
  });
});
