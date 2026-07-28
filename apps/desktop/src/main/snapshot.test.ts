import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

// snapshot.ts reads app.getPath('userData'); point it at a throwaway dir. The
// factory closes over `userData`, which is only READ when getPath() is called
// (inside tests), by which point beforeAll has assigned it.
let userData = "";
vi.mock("electron", () => ({ app: { getPath: () => userData } }));

import {
  captureCheckpoint,
  ensureBaseline,
  gc,
  hasCheckpoint,
  restoreCheckpoint,
  sanitizeTaskId,
  snapshotDiff,
  snapshotRevertAll,
  snapshotRevertFile,
  snapshotSummary,
} from "./snapshot";

beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), "wello-snap-ud-"));
});

async function newWorkspace(): Promise<string> {
  return mkdtempSync(join(tmpdir(), "wello-snap-ws-"));
}
async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true).catch(() => false);
}

describe("sanitizeTaskId", () => {
  it("accepts uuid-shaped ids and rejects traversal", () => {
    expect(sanitizeTaskId("a1b2-C3_d4")).toBe("a1b2-C3_d4");
    expect(() => sanitizeTaskId("../evil")).toThrow();
    expect(() => sanitizeTaskId("a/b")).toThrow();
    expect(() => sanitizeTaskId("")).toThrow();
  });
});

describe("snapshot review", () => {
  it("detects added, modified, and deleted files vs the baseline", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "keep.txt"), "same\n");
    await writeFile(join(ws, "edit.txt"), "one\ntwo\n");
    await writeFile(join(ws, "gone.txt"), "bye\n");
    await ensureBaseline("task-a", ws);

    await writeFile(join(ws, "edit.txt"), "one\ntwoX\n"); // modify (size changes too)
    await writeFile(join(ws, "new.txt"), "hello\n"); // add
    await rm(join(ws, "gone.txt")); // delete

    const sum = await snapshotSummary("task-a", ws);
    const byPath = Object.fromEntries(sum.files.map((f) => [f.path, f.status]));
    expect(byPath["edit.txt"]).toBe("modified");
    expect(byPath["new.txt"]).toBe("added");
    expect(byPath["gone.txt"]).toBe("deleted");
    expect(byPath["keep.txt"]).toBeUndefined(); // unchanged files are skipped
    expect(sum.backing).toBe("snapshot");
    expect(sum.additions).toBeGreaterThan(0);
  });

  it("ensureBaseline is a no-op once a manifest exists", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "a.txt"), "1\n");
    await ensureBaseline("task-b", ws);
    await writeFile(join(ws, "a.txt"), "2\n"); // change AFTER the baseline
    await ensureBaseline("task-b", ws); // must NOT re-baseline over the change
    const sum = await snapshotSummary("task-b", ws);
    expect(sum.files.map((f) => f.path)).toContain("a.txt");
  });

  it("snapshotDiff renders a unified diff for a modified file", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "m.txt"), "alpha\nbeta\n");
    await ensureBaseline("task-c", ws);
    await writeFile(join(ws, "m.txt"), "alpha\nBETA\n");
    const { diff, untracked } = await snapshotDiff("task-c", ws, "m.txt");
    expect(untracked).toBe(false);
    expect(diff).toContain("-beta");
    expect(diff).toContain("+BETA");
  });

  it("revertFile restores a modified file and deletes an added one", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "m.txt"), "orig\n");
    await ensureBaseline("task-d", ws);
    await writeFile(join(ws, "m.txt"), "changed\n");
    await writeFile(join(ws, "added.txt"), "new\n");

    await snapshotRevertFile("task-d", ws, "m.txt");
    expect(await readFile(join(ws, "m.txt"), "utf8")).toBe("orig\n");

    await snapshotRevertFile("task-d", ws, "added.txt");
    expect(await exists(join(ws, "added.txt"))).toBe(false);
  });

  it("revertAll restores every change at once", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "a.txt"), "A\n");
    await writeFile(join(ws, "b.txt"), "B\n");
    await ensureBaseline("task-e", ws);
    await writeFile(join(ws, "a.txt"), "A2\n");
    await writeFile(join(ws, "c.txt"), "C\n");
    await snapshotRevertAll("task-e", ws);
    expect(await readFile(join(ws, "a.txt"), "utf8")).toBe("A\n");
    expect(await exists(join(ws, "c.txt"))).toBe(false);
  });

  it("ignores IGNORE_DIRS like node_modules", async () => {
    const ws = await newWorkspace();
    await mkdir(join(ws, "node_modules"));
    await writeFile(join(ws, "node_modules", "x.js"), "junk\n");
    await writeFile(join(ws, "real.txt"), "r\n");
    await ensureBaseline("task-f", ws);
    await writeFile(join(ws, "node_modules", "y.js"), "more\n"); // must stay invisible
    await writeFile(join(ws, "real.txt"), "r2\n");
    const sum = await snapshotSummary("task-f", ws);
    expect(sum.files.map((f) => f.path)).toEqual(["real.txt"]);
  });
});

describe("checkpoints (rewind)", () => {
  it("restores files to a captured turn and deletes files added since", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "app.ts"), "v1\n");
    await writeFile(join(ws, "keep.md"), "docs\n");
    // Checkpoint BEFORE the turn.
    await captureCheckpoint("task-cp", "run-1", ws);
    expect(await hasCheckpoint("task-cp", "run-1")).toBe(true);
    expect(await hasCheckpoint("task-cp", "run-x")).toBe(false);

    // The "turn" edits a file, creates one, deletes another.
    await writeFile(join(ws, "app.ts"), "v2 edited\n");
    await writeFile(join(ws, "generated.ts"), "new file\n");
    await rm(join(ws, "keep.md"));

    const ok = await restoreCheckpoint("task-cp", "run-1", ws);
    expect(ok).toBe(true);
    expect(await readFile(join(ws, "app.ts"), "utf8")).toBe("v1\n"); // reverted
    expect(await readFile(join(ws, "keep.md"), "utf8")).toBe("docs\n"); // re-created
    expect(await exists(join(ws, "generated.ts"))).toBe(false); // removed
  });

  it("returns false for a missing checkpoint", async () => {
    const ws = await newWorkspace();
    expect(await restoreCheckpoint("task-cp", "nope", ws)).toBe(false);
  });

  // A checkpoint re-uses the previous scan's hash for any file whose size and
  // mtime are unchanged (that's what keeps a per-turn checkpoint cheap), so the
  // edits it MUST still catch are worth pinning: one that keeps the byte count
  // and only moves mtime, one that changes size.
  it("a later checkpoint records the edits made since the previous one", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "same-size.ts"), "v1\n");
    await writeFile(join(ws, "grows.ts"), "a\n");
    await captureCheckpoint("task-inc", "run-1", ws);

    await writeFile(join(ws, "same-size.ts"), "v2\n");
    const later = new Date(Date.now() + 2000);
    await utimes(join(ws, "same-size.ts"), later, later); // same size, newer mtime
    await writeFile(join(ws, "grows.ts"), "a longer line\n");
    await captureCheckpoint("task-inc", "run-2", ws);

    await writeFile(join(ws, "same-size.ts"), "v3\n");
    await writeFile(join(ws, "grows.ts"), "wiped\n");

    expect(await restoreCheckpoint("task-inc", "run-2", ws)).toBe(true);
    expect(await readFile(join(ws, "same-size.ts"), "utf8")).toBe("v2\n");
    expect(await readFile(join(ws, "grows.ts"), "utf8")).toBe("a longer line\n");

    expect(await restoreCheckpoint("task-inc", "run-1", ws)).toBe(true);
    expect(await readFile(join(ws, "same-size.ts"), "utf8")).toBe("v1\n");
    expect(await readFile(join(ws, "grows.ts"), "utf8")).toBe("a\n");
  });

  it("re-reads a file whose stored blob went missing", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "f.ts"), "content\n");
    await captureCheckpoint("task-blob", "run-1", ws);
    // Wipe the object store: the scan hint still lists the file, but its bytes
    // are gone — the next checkpoint has to read and store it again, or a rewind
    // would silently do nothing.
    await rm(join(userData, "review-snapshots", "objects"), { recursive: true, force: true });
    await captureCheckpoint("task-blob", "run-2", ws);

    await writeFile(join(ws, "f.ts"), "changed\n");
    expect(await restoreCheckpoint("task-blob", "run-2", ws)).toBe(true);
    expect(await readFile(join(ws, "f.ts"), "utf8")).toBe("content\n");
  });

  it("a second chat on the same folder shares the stored bytes", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "shared.ts"), "original\n");
    await captureCheckpoint("task-chat-1", "run-1", ws);
    // A different task, same folder: it re-uses the first chat's scan hint and
    // blobs, and must still be able to restore on its own.
    await captureCheckpoint("task-chat-2", "run-1", ws);
    await writeFile(join(ws, "shared.ts"), "edited by the agent\n");

    expect(await restoreCheckpoint("task-chat-2", "run-1", ws)).toBe(true);
    expect(await readFile(join(ws, "shared.ts"), "utf8")).toBe("original\n");
  });

  // The regression this pins is the one users felt: a checkpoint runs before
  // EVERY turn, and re-reading the whole project each time froze the app for
  // tens of seconds on a real repo. The second checkpoint must ride on the
  // first one's scan. Ratio, not milliseconds, so a slow CI box still passes.
  it("a repeat checkpoint costs a fraction of the first one", async () => {
    const ws = await newWorkspace();
    const body = `// ${"x".repeat(80)}\n`.repeat(250); // ~20 KB per file
    await mkdir(join(ws, "src"), { recursive: true });
    for (let i = 0; i < 400; i++) {
      await writeFile(join(ws, "src", `mod${i}.ts`), `export const id = ${i};\n${body}`);
    }

    const t0 = Date.now();
    await captureCheckpoint("task-cost", "run-1", ws);
    const first = Date.now() - t0;
    const t1 = Date.now();
    await captureCheckpoint("task-cost", "run-2", ws);
    const second = Date.now() - t1;

    expect(second).toBeLessThan(first / 2);
  }, 60_000);

  it("gc adopts a pre-shared-store task's blobs instead of stranding them", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "old.ts"), "bytes from an older version\n");
    await captureCheckpoint("task-legacy", "run-1", ws);
    // Simulate the old layout: the blob lives in the task's own folder only.
    const objects = join(userData, "review-snapshots", "objects");
    const legacy = join(userData, "review-snapshots", "task-legacy", "objects");
    await mkdir(legacy, { recursive: true });
    for (const name of await readdir(objects)) {
      await writeFile(join(legacy, name), await readFile(join(objects, name)));
    }
    await rm(objects, { recursive: true, force: true });

    await gc(["task-legacy"]);

    // The folder is gone, the bytes are not: a rewind still works.
    expect(await exists(legacy)).toBe(false);
    await writeFile(join(ws, "old.ts"), "changed\n");
    expect(await restoreCheckpoint("task-legacy", "run-1", ws)).toBe(true);
    expect(await readFile(join(ws, "old.ts"), "utf8")).toBe("bytes from an older version\n");
  }, 30_000);

  it("gc drops blobs no task references and keeps the ones still used", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "live.ts"), "kept by task-live\n");
    await captureCheckpoint("task-live", "run-1", ws);
    await writeFile(join(ws, "live.ts"), "only task-dead has these bytes\n");
    await captureCheckpoint("task-dead", "run-1", ws);

    const objects = join(userData, "review-snapshots", "objects");
    const before = (await readdir(objects)).length;
    await gc(["task-live"]);
    const after = await readdir(objects);
    expect(after.length).toBeLessThan(before);
    // The surviving task can still rewind.
    await writeFile(join(ws, "live.ts"), "changed again\n");
    expect(await restoreCheckpoint("task-live", "run-1", ws)).toBe(true);
    expect(await readFile(join(ws, "live.ts"), "utf8")).toBe("kept by task-live\n");
    expect(await exists(join(userData, "review-snapshots", "task-dead"))).toBe(false);
  }, 30_000);

  it("never touches IGNORE_DIRS on restore", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "src.ts"), "a\n");
    await captureCheckpoint("task-cp2", "run-1", ws);
    await mkdir(join(ws, "node_modules"));
    await writeFile(join(ws, "node_modules", "dep.js"), "installed\n");
    await restoreCheckpoint("task-cp2", "run-1", ws);
    // node_modules is outside the tracked tree — restore leaves it alone.
    expect(await exists(join(ws, "node_modules", "dep.js"))).toBe(true);
  });

  it("a PARTIAL checkpoint never deletes the user's own uncaptured large files", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "code.ts"), "v1\n");
    // A pre-existing file too big to snapshot (> 2MB cap) → checkpoint is partial
    // and does NOT record it. Restore must not treat it as "created since".
    await writeFile(join(ws, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 7));
    await captureCheckpoint("task-partial", "run-1", ws);

    await writeFile(join(ws, "code.ts"), "v2 edited\n");
    const ok = await restoreCheckpoint("task-partial", "run-1", ws);
    expect(ok).toBe(true);
    expect(await readFile(join(ws, "code.ts"), "utf8")).toBe("v1\n"); // recorded file reverted
    expect(await exists(join(ws, "big.bin"))).toBe(true); // the user's large file survives
  });
});
