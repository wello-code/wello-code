import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The store is told where to live (the app passes userData; the worker gets it
// over workerData) — point it at a throwaway dir.
let userData = "";

import {
  captureCheckpoint,
  configureSnapshots,
  prepareTurn,
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
import { storeBytes } from "./object-store";

beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), "wello-snap-ud-"));
  configureSnapshots(userData);
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
    // would silently do nothing. (configureSnapshots also drops the in-memory
    // index, which is what a restart would do.)
    await rm(join(userData, "review-snapshots", "packs"), { recursive: true, force: true });
    await rm(join(userData, "review-snapshots", "objects"), { recursive: true, force: true });
    configureSnapshots(userData);
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
  // EVERY turn, and re-reading (and re-storing) the whole project each time
  // froze the app for tens of seconds on a real repo. Bytes, not milliseconds —
  // a repeat that stores nothing is the invariant; a stopwatch on CI is noise.
  it("a repeat checkpoint re-reads and re-stores nothing", async () => {
    const ws = await newWorkspace();
    const body = `// ${"x".repeat(80)}\n`.repeat(250); // ~20 KB per file
    await mkdir(join(ws, "src"), { recursive: true });
    for (let i = 0; i < 400; i++) {
      await writeFile(join(ws, "src", `mod${i}.ts`), `export const id = ${i};\n${body}`);
    }

    const empty = await storeBytes();
    const t0 = Date.now();
    await captureCheckpoint("task-cost", "run-1", ws);
    const first = Date.now() - t0;
    const afterFirst = await storeBytes();
    expect(afterFirst).toBeGreaterThan(empty); // the tree really was stored

    const t1 = Date.now();
    await captureCheckpoint("task-cost", "run-2", ws);
    const second = Date.now() - t1;

    expect(await storeBytes()).toBe(afterFirst); // nothing re-read, nothing re-stored
    expect(second).toBeLessThanOrEqual(first);
  }, 60_000);

  // 400 files used to mean 400 file creations in the object store, each one a
  // few milliseconds on Windows — the single most expensive thing the app did.
  it("stores a whole tree in a handful of files, not one per blob", async () => {
    const ws = await newWorkspace();
    await mkdir(join(ws, "src"), { recursive: true });
    for (let i = 0; i < 400; i++) {
      await writeFile(join(ws, "src", `f${i}.ts`), `export const n = ${i};\n${"y".repeat(500)}`);
    }
    await captureCheckpoint("task-pack", "run-1", ws);

    const packs = await readdir(join(userData, "review-snapshots", "packs"));
    expect(packs.length).toBeLessThanOrEqual(4); // pack + index, maybe one roll
  }, 60_000);

  // A turn must never wait on the filesystem without a ceiling: a network drive
  // or a virus scanner mid-scan is not ours to control. Past the budget the
  // checkpoint keeps what it captured and marks itself partial — which restore
  // already handles by leaving unrecorded files alone.
  it("gives up on time instead of making the turn wait", async () => {
    const ws = await newWorkspace();
    await mkdir(join(ws, "src"), { recursive: true });
    for (let i = 0; i < 200; i++) {
      await writeFile(join(ws, "src", `f${i}.ts`), `export const n = ${i};\n${"z".repeat(2000)}`);
    }
    await writeFile(join(ws, "keep.ts"), "const a = 1;\n");

    // A git repo with nothing dirty: the baseline is free, so what is measured
    // here is the per-turn checkpoint — the part that has the ceiling.
    const t0 = Date.now();
    await prepareTurn("task-budget", "run-1", ws, [], 0); // no time at all
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(await hasCheckpoint("task-budget", "run-1")).toBe(true);

    // Files the checkpoint never recorded are left exactly as they are.
    await writeFile(join(ws, "keep.ts"), "const a = 2;\n");
    expect(await restoreCheckpoint("task-budget", "run-1", ws)).toBe(true);
    expect(await readFile(join(ws, "keep.ts"), "utf8")).toBe("const a = 2;\n");
  }, 30_000);

  it("gc adopts a pre-shared-store task's blobs instead of stranding them", async () => {
    const ws = await newWorkspace();
    const body = "bytes from an older version\n";
    await writeFile(join(ws, "old.ts"), body);
    await captureCheckpoint("task-legacy", "run-1", ws);
    // Simulate the old layout: the blob lives in the task's own folder only,
    // one file per hash, and the shared store knows nothing about it.
    const legacy = join(userData, "review-snapshots", "task-legacy", "objects");
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, createHash("sha256").update(body).digest("hex")), body);
    await rm(join(userData, "review-snapshots", "packs"), { recursive: true, force: true });
    configureSnapshots(userData);

    await gc(["task-legacy"]);

    // The folder is gone, the bytes are not: a rewind still works.
    expect(await exists(legacy)).toBe(false);
    await writeFile(join(ws, "old.ts"), "changed\n");
    expect(await restoreCheckpoint("task-legacy", "run-1", ws)).toBe(true);
    expect(await readFile(join(ws, "old.ts"), "utf8")).toBe(body);
  }, 30_000);

  it("gc drops blobs no task references and keeps the ones still used", async () => {
    const ws = await newWorkspace();
    // Blobs big enough that the sweep's "is this worth a rewrite" rule fires on
    // the ratio (half the store is about to become garbage).
    const kept = `kept by task-live\n${"a".repeat(40_000)}`;
    await writeFile(join(ws, "live.ts"), kept);
    await captureCheckpoint("task-live", "run-1", ws);
    await writeFile(join(ws, "live.ts"), `only task-dead has these bytes\n${"b".repeat(40_000)}`);
    await captureCheckpoint("task-dead", "run-1", ws);

    const before = await storeBytes();
    await gc(["task-live"]);
    expect(await storeBytes()).toBeLessThan(before);
    // The surviving task can still rewind.
    await writeFile(join(ws, "live.ts"), "changed again\n");
    expect(await restoreCheckpoint("task-live", "run-1", ws)).toBe(true);
    expect(await readFile(join(ws, "live.ts"), "utf8")).toBe(kept);
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

describe("a baseline that could not capture everything", () => {
  /** A file over the per-file ceiling is skipped at capture, which makes the
   *  whole baseline partial — the exact shape of the report: a folder with a
   *  handful of big PDFs. */
  async function workspaceWithBigFile(): Promise<string> {
    const ws = await newWorkspace();
    await writeFile(join(ws, "notes.md"), "small file\n");
    await writeFile(join(ws, "big.bin"), Buffer.alloc(3 * 1024 * 1024, 7)); // > 2 MB cap
    return ws;
  }

  it("does not blame the user's own files on the agent", async () => {
    const ws = await workspaceWithBigFile();
    await ensureBaseline("partial-1", ws);
    // Nothing touched the folder since the baseline.
    const sum = await snapshotSummary("partial-1", ws);
    expect(sum.files).toEqual([]);
    expect(sum.additions).toBe(0);
  });

  it("still reports what the agent really changed", async () => {
    const ws = await workspaceWithBigFile();
    await ensureBaseline("partial-2", ws);
    await writeFile(join(ws, "notes.md"), "small file\nedited by the agent\n");
    const sum = await snapshotSummary("partial-2", ws);
    expect(sum.files.map((f) => f.path)).toEqual(["notes.md"]);
    expect(sum.files[0]!.status).toBe("modified");
  });

  it("REFUSES to delete a file it cannot prove is new", async () => {
    // «Отменить» on a falsely-added file used to remove the user's own data.
    const ws = await workspaceWithBigFile();
    await ensureBaseline("partial-3", ws);
    await snapshotRevertFile("partial-3", ws, "big.bin");
    expect(await exists(join(ws, "big.bin"))).toBe(true);
    await snapshotRevertAll("partial-3", ws);
    expect(await exists(join(ws, "big.bin"))).toBe(true);
  });

  it("a COMPLETE baseline still calls a new file added — and revert removes it", async () => {
    const ws = await newWorkspace();
    await writeFile(join(ws, "a.txt"), "one\n");
    await ensureBaseline("full-1", ws);
    await writeFile(join(ws, "b.txt"), "made by the agent\n");
    const sum = await snapshotSummary("full-1", ws);
    expect(sum.files.map((f) => `${f.status} ${f.path}`)).toEqual(["added b.txt"]);
    await snapshotRevertFile("full-1", ws, "b.txt");
    expect(await exists(join(ws, "b.txt"))).toBe(false);
  });
});
