import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
