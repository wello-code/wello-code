import { promises as fs } from "node:fs";
import { join } from "node:path";

/**
 * The one-click support bundle: a single text file the user attaches to a
 * support chat. One file on purpose — "прикрепите вот это" beats a folder of
 * artifacts for a non-technical reporter, and everything a first-line diagnosis
 * needs fits: versions, environment, live process load, and the log tail
 * (which now carries the engine's stderr, i.e. the actual API errors).
 */

/** How much of the log rides along. The tail is where the incident is. */
const LOG_TAIL_BYTES = 256 * 1024;

/**
 * Belt-and-suspenders scrub: nothing here is EXPECTED to hold a credential
 * (keys live in env, never logged), but a support file leaves the machine, so
 * anything shaped like a token is masked anyway.
 */
export function scrubSecrets(text: string): string {
  return (
    text
      // Wello API keys.
      .replace(/wlo_live_[a-f0-9]{8,}/gi, "wlo_live_[скрыто]")
      // GitHub tokens (classic + fine-grained + OAuth).
      .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "gh_[скрыто]")
      .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "github_pat_[скрыто]")
      // Bearer headers, whatever the token flavour.
      .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, "$1 [скрыто]")
  );
}

export interface SupportReportInput {
  appVersion: string;
  electronVersion: string;
  platform: string;
  arch: string;
  osVersion: string;
  /** perfReportText(): per-process CPU/memory + GPU feature matrix. */
  perfText: string;
  /** The tail of main.log (already size-capped by the reader). */
  logTail: string;
  now?: Date;
}

/** Pure assembly — the file's whole content. */
export function buildSupportReport(input: SupportReportInput): string {
  const now = input.now ?? new Date();
  const head = [
    "Wello Code — отчёт для поддержки",
    `Создан: ${now.toISOString()}`,
    `Версия приложения: ${input.appVersion}`,
    `Electron: ${input.electronVersion}`,
    `Система: ${input.platform} ${input.arch} (${input.osVersion})`,
  ].join("\n");
  return scrubSecrets(
    [
      head,
      "── Нагрузка и графика ──────────────────────────",
      input.perfText.trim(),
      `── Хвост журнала (последние ${Math.round(LOG_TAIL_BYTES / 1024)} КБ) ──`,
      input.logTail.trim() || "(журнал пуст)",
      "",
    ].join("\n\n"),
  );
}

/** Read at most the last `cap` bytes of a file (absent file → empty string). */
export async function readTail(path: string, cap = LOG_TAIL_BYTES): Promise<string> {
  try {
    const stat = await fs.stat(path);
    const start = Math.max(0, stat.size - cap);
    const handle = await fs.open(path, "r");
    try {
      const buf = Buffer.alloc(stat.size - start);
      await handle.read(buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

/** Where report files land (given userData); the folder is created on demand. */
export async function reportFilePath(userData: string, now = new Date()): Promise<string> {
  const dir = join(userData, "reports");
  await fs.mkdir(dir, { recursive: true });
  const stamp = now
    .toISOString()
    .slice(0, 16)
    .replace(/[:T]/g, "-");
  return join(dir, `wello-report-${stamp}.txt`);
}
