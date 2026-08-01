import { parentPort, workerData } from "node:worker_threads";
import {
  captureCheckpoint,
  configureSnapshots,
  ensureBaseline,
  ensureGitBaseline,
  forget,
  gc,
  hasCheckpoint,
  loadGitBaseline,
  matchesGitBaseline,
  prepareTurn,
  restoreCheckpoint,
  restoreGitBaselineFile,
  snapshotDiff,
  snapshotRevertAll,
  snapshotRevertFile,
  snapshotSummary,
} from "./snapshot";

/**
 * The snapshot store, run off the main thread.
 *
 * Everything here walks, stats, reads and hashes a whole project, which on a
 * real repo is thousands of filesystem round trips. In the main process those
 * fill Node's four-thread pool, so every OTHER piece of main-process work —
 * saving the chat, answering an IPC call from the window — queues behind them,
 * and the app looks frozen exactly while a turn is starting. Here it is a
 * separate thread with its own pool, and the window never notices.
 *
 * The protocol is one request/response pair per call, matched by id. Arguments
 * and results are plain JSON values (structured clone), and every operation is
 * idempotent, so a crashed worker is replaced and the call simply runs again.
 */

const ops = {
  prepareTurn,
  ensureBaseline,
  ensureGitBaseline,
  captureCheckpoint,
  hasCheckpoint,
  restoreCheckpoint,
  snapshotSummary,
  snapshotDiff,
  snapshotRevertFile,
  snapshotRevertAll,
  loadGitBaseline,
  matchesGitBaseline,
  restoreGitBaselineFile,
  forget,
  gc,
} as const;

export type SnapshotOp = keyof typeof ops;

configureSnapshots(String((workerData as { userData?: unknown })?.userData ?? ""));

parentPort?.on("message", (msg: { id: number; op: SnapshotOp; args: unknown[] }) => {
  const run = async (): Promise<unknown> => {
    // Own properties only: a name like "constructor" must not resolve to
    // something inherited and get called.
    if (!Object.prototype.hasOwnProperty.call(ops, msg.op)) {
      throw new Error(`Unknown snapshot op: ${String(msg.op)}`);
    }
    const fn = ops[msg.op] as (...a: unknown[]) => Promise<unknown>;
    return fn(...msg.args);
  };
  void run().then(
    (value) => parentPort?.postMessage({ id: msg.id, ok: true, value }),
    (err: unknown) =>
      parentPort?.postMessage({
        id: msg.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
  );
});
