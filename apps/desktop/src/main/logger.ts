import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { app, dialog } from "electron";

/**
 * Main-process file log. Until now a crash left the user with nothing to send:
 * the renderer's console dies with the window and main wrote only to a terminal
 * nobody sees in a packaged build. Everything lands in
 * `userData/logs/main.log`, and Settings → «О приложении» shows the path so a bug
 * report can just attach the file.
 *
 * Writes are SYNCHRONOUS on purpose. The whole point is surviving a crash, and an
 * async append loses the last (most interesting) lines when the process is going
 * down. Volume is low — lifecycle events and failures, not a trace log — so the
 * blocking cost is irrelevant.
 *
 * Rotation keeps exactly one previous file: main.log grows to MAX_BYTES, becomes
 * main.log.1 (replacing the older one), and a fresh main.log starts. Two bounded
 * files, no unbounded growth, no cleanup job.
 */

const MAX_BYTES = 2 * 1024 * 1024;

export type LogLevel = "info" | "warn" | "error";

/** One log line. Pure — the format is asserted in tests. */
export function formatLine(level: LogLevel, message: string, meta?: unknown, now = new Date()): string {
  const stamp = now.toISOString();
  let tail = "";
  if (meta !== undefined) {
    if (meta instanceof Error) {
      tail = ` ${meta.stack ?? `${meta.name}: ${meta.message}`}`;
    } else {
      try {
        tail = ` ${JSON.stringify(meta)}`;
      } catch {
        // Circular or otherwise unserialisable: never let logging throw.
        tail = " [unserialisable meta]";
      }
    }
  }
  return `${stamp} ${level.toUpperCase().padEnd(5)} ${message}${tail}\n`;
}

/** Should the current file be rolled before appending? Pure. */
export function shouldRotate(currentBytes: number, incoming: number, max = MAX_BYTES): boolean {
  return currentBytes > 0 && currentBytes + incoming > max;
}

function logsDir(): string {
  return join(app.getPath("userData"), "logs");
}

/** Absolute path of the active log file. Shown to the user, so keep it stable. */
export function logPath(): string {
  return join(logsDir(), "main.log");
}

function rotateIfNeeded(incoming: number): void {
  const file = logPath();
  if (!existsSync(file)) return;
  const size = statSync(file).size;
  if (!shouldRotate(size, incoming)) return;
  renameSync(file, `${file}.1`); // replaces the previous roll
}

let warnedAboutLogging = false;

function write(level: LogLevel, message: string, meta?: unknown): void {
  const line = formatLine(level, message, meta);
  const mirror = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  mirror(line.trimEnd());
  try {
    mkdirSync(logsDir(), { recursive: true });
    rotateIfNeeded(Buffer.byteLength(line));
    appendFileSync(logPath(), line, "utf8");
  } catch (err) {
    // A broken log must never take the app down (read-only profile, full disk).
    // Say so once, then stay quiet.
    if (!warnedAboutLogging) {
      warnedAboutLogging = true;
      console.error("file logging unavailable:", err);
    }
  }
}

export const log = {
  info: (message: string, meta?: unknown) => write("info", message, meta),
  warn: (message: string, meta?: unknown) => write("warn", message, meta),
  error: (message: string, meta?: unknown) => write("error", message, meta),
};

let reportedCrash = false;

/**
 * Catch what would otherwise vanish. We deliberately do NOT quit on an uncaught
 * exception: most arrive from a non-critical async path, and killing the app
 * would abort a running agent turn and lose the user's work — a worse outcome
 * than continuing in a slightly suspect state. The user is told once per session
 * (a dialog per exception would be its own kind of crash), and everything is on
 * disk regardless.
 */
export function installCrashHandlers(): void {
  process.on("uncaughtException", (err, origin) => {
    log.error(`uncaught exception (${origin})`, err);
    if (reportedCrash) return;
    reportedCrash = true;
    try {
      dialog.showErrorBox(
        "Wello Code: внутренняя ошибка",
        `Приложение продолжит работу, но что-то пошло не так.\n\n` +
          `Подробности записаны в файл:\n${logPath()}\n\n` +
          `Если проблема повторяется, пришлите этот файл в поддержку.`,
      );
    } catch {
      // Pre-`ready` crashes have no dialog available; the log line is enough.
    }
  });

  process.on("unhandledRejection", (reason) => {
    log.error("unhandled promise rejection", reason);
  });
}
