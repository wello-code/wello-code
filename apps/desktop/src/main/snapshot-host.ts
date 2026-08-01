import { Worker } from "node:worker_threads";
import { app } from "electron";
import type { ChangeSummary } from "../shared/ipc-api";
import { log } from "./logger";
import * as inProcess from "./snapshot";
import type { GitBaseline, SnapshotFileMeta } from "./snapshot";
import type { SnapshotOp } from "./snapshot-worker";

/**
 * Main-process face of the snapshot store: same functions, run in a worker.
 *
 * Why it matters (measured on Windows 11, a 3000-file project, 2026-08-01): a
 * checkpoint before a turn costs ~1.8 s of filesystem work, and the first one in
 * a project used to cost 16 s. All of it went through the main process, whose
 * thread pool then had nothing left for the window's own IPC — which is what
 * "приложение висит и не реагирует по 30 секунд" was.
 *
 * If the worker cannot start (a packaging surprise, an exotic platform) every
 * call falls back to running here, exactly as before. Slower, never broken.
 */

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** The same work, run in this process — used when the worker dies mid-call. */
  retry: () => Promise<unknown>;
}

/** A single call may not outlive this. Nothing here should take a minute; if it
 *  does, failing is better than a turn that never starts. */
const CALL_TIMEOUT_MS = 5 * 60_000;
/** Past this, the user felt it — leave a line so the next report has the number
 *  instead of "приложение висело". */
const SLOW_CALL_MS = 3_000;

let worker: Worker | null = null;
let disabled = false;
let nextId = 1;
const pending = new Map<number, Pending>();

/**
 * The worker owns the store, but this process points its own copy of the module
 * at the same folder too: the fallback path needs it, and so does the perf
 * report, which measures how much disk the snapshots take. Called once at
 * startup (and again by the fallback, which is idempotent).
 */
export function configureSnapshotPaths(): void {
  inProcess.configureSnapshots(app.getPath("userData"));
}

/**
 * The worker died with calls outstanding. Those calls are a turn waiting to
 * start, so they are re-run HERE rather than failed — slower beats stuck.
 */
function rescuePending(): void {
  const stranded = [...pending.values()];
  pending.clear();
  if (stranded.length > 0) configureSnapshotPaths();
  for (const p of stranded) {
    clearTimeout(p.timer);
    p.retry().then(p.resolve, (err: unknown) =>
      p.reject(err instanceof Error ? err : new Error(String(err))),
    );
  }
}

function spawn(): Worker | null {
  if (disabled) return null;
  try {
    const w = new Worker(new URL("./snapshot-worker.js", import.meta.url), {
      workerData: { userData: app.getPath("userData") },
    });
    w.on("message", (msg: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.value);
      else p.reject(new Error(msg.error ?? "snapshot worker error"));
    });
    w.on("error", (err) => {
      // The worker itself failed (it could not even load). Stop trying: from
      // here on every call runs in the main process, exactly as it used to.
      log.warn(`snapshot worker unusable, falling back to the main process: ${err.message}`);
      disabled = true;
      worker = null;
      rescuePending();
    });
    w.on("exit", () => {
      // A worker that exits on its own leaves nothing to answer with; the next
      // call spawns a fresh one (every operation is idempotent).
      if (worker === w) worker = null;
      rescuePending();
    });
    // Never hold the app open for it.
    w.unref();
    return w;
  } catch (err) {
    disabled = true;
    log.warn(
      `snapshot worker unavailable, falling back to the main process: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

async function call<T>(op: SnapshotOp, args: unknown[], here: () => Promise<T>): Promise<T> {
  const started = Date.now();
  const timed = <R>(result: Promise<R>): Promise<R> =>
    result.finally(() => {
      const ms = Date.now() - started;
      if (ms >= SLOW_CALL_MS) log.warn(`snapshot ${op} took ${ms} ms`);
    });
  if (!worker) worker = spawn();
  const w = worker;
  if (!w) {
    // No worker: run in this process, and make sure the store knows where it is.
    configureSnapshotPaths();
    return timed(here());
  }
  const id = nextId++;
  return timed(
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`snapshot ${op} timed out`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
        retry: here as () => Promise<unknown>,
      });
      w.postMessage({ id, op, args });
    }),
  );
}

/** Baseline + per-turn checkpoint in one call and one tree scan (see snapshot.ts). */
export function prepareTurn(
  taskId: string,
  turnId: string,
  cwd: string,
  dirtyPaths: string[] | null,
): Promise<void> {
  return call("prepareTurn", [taskId, turnId, cwd, dirtyPaths], () =>
    inProcess.prepareTurn(taskId, turnId, cwd, dirtyPaths),
  );
}

export function ensureBaseline(taskId: string, cwd: string): Promise<void> {
  return call("ensureBaseline", [taskId, cwd], async () => {
    await inProcess.ensureBaseline(taskId, cwd);
  });
}

export function ensureGitBaseline(taskId: string, cwd: string, dirtyPaths: string[]): Promise<void> {
  return call("ensureGitBaseline", [taskId, cwd, dirtyPaths], () =>
    inProcess.ensureGitBaseline(taskId, cwd, dirtyPaths),
  );
}

export function captureCheckpoint(taskId: string, turnId: string, cwd: string): Promise<void> {
  return call("captureCheckpoint", [taskId, turnId, cwd], () =>
    inProcess.captureCheckpoint(taskId, turnId, cwd),
  );
}

export function hasCheckpoint(taskId: string, turnId: string): Promise<boolean> {
  return call("hasCheckpoint", [taskId, turnId], () => inProcess.hasCheckpoint(taskId, turnId));
}

export function restoreCheckpoint(taskId: string, turnId: string, cwd: string): Promise<boolean> {
  return call("restoreCheckpoint", [taskId, turnId, cwd], () =>
    inProcess.restoreCheckpoint(taskId, turnId, cwd),
  );
}

export function snapshotSummary(taskId: string, cwd: string): Promise<ChangeSummary> {
  return call("snapshotSummary", [taskId, cwd], () => inProcess.snapshotSummary(taskId, cwd));
}

export function snapshotDiff(
  taskId: string,
  cwd: string,
  rel: string,
): Promise<{ diff: string; untracked: boolean }> {
  return call("snapshotDiff", [taskId, cwd, rel], () => inProcess.snapshotDiff(taskId, cwd, rel));
}

export function snapshotRevertFile(taskId: string, cwd: string, rel: string): Promise<void> {
  return call("snapshotRevertFile", [taskId, cwd, rel], () =>
    inProcess.snapshotRevertFile(taskId, cwd, rel),
  );
}

export function snapshotRevertAll(taskId: string, cwd: string): Promise<void> {
  return call("snapshotRevertAll", [taskId, cwd], () => inProcess.snapshotRevertAll(taskId, cwd));
}

export function loadGitBaseline(taskId: string): Promise<GitBaseline | null> {
  return call("loadGitBaseline", [taskId], () => inProcess.loadGitBaseline(taskId));
}

export function matchesGitBaseline(
  cwd: string,
  rel: string,
  meta: SnapshotFileMeta,
): Promise<boolean> {
  return call("matchesGitBaseline", [cwd, rel, meta], () =>
    inProcess.matchesGitBaseline(cwd, rel, meta),
  );
}

export function restoreGitBaselineFile(taskId: string, cwd: string, rel: string): Promise<boolean> {
  return call("restoreGitBaselineFile", [taskId, cwd, rel], () =>
    inProcess.restoreGitBaselineFile(taskId, cwd, rel),
  );
}

export function forget(taskId: string): Promise<void> {
  return call("forget", [taskId], () => inProcess.forget(taskId));
}

export function gc(knownTaskIds: string[]): Promise<void> {
  return call("gc", [knownTaskIds], () => inProcess.gc(knownTaskIds));
}

/** Stop the worker (app quit). Anything still in flight finishes here instead. */
export function stopSnapshotWorker(): void {
  const w = worker;
  worker = null;
  rescuePending();
  void w?.terminate();
}
