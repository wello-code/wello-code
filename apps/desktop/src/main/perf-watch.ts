import { app } from "electron";
import { log } from "./logger";
import { hardwareAccelerationEnabledSync } from "./settings-store";
import { saveStats } from "./state-store";

/**
 * Who is actually burning the machine.
 *
 * "The app slows down and the fans spin up after an answer" is a report we
 * cannot act on: it names the window, and a window is four processes plus the
 * engine. Electron already accounts per process — type, CPU share and working
 * set — so we sample that and write a line to the log whenever it looks
 * abnormal, which turns the next report into evidence instead of a feeling.
 *
 * Cheap by construction: one sample every 30 s, and a line only when a threshold
 * trips (or the user explicitly asks for a report). A quiet machine writes
 * nothing at all.
 */

/** Sampling period. Long enough to be free, short enough to catch a spike. */
const SAMPLE_MS = 30_000;
/** One process pinning most of a core is worth a line. */
const CPU_PCT_ALERT = 25;
/** Everything the app holds, in MB. Normal idle is ~350; 1.2 GB is not. */
const TOTAL_MB_ALERT = 1200;
/** Never log more than one alert per this interval — a stuck spike is one line. */
const ALERT_COOLDOWN_MS = 5 * 60_000;

export interface ProcSample {
  type: string;
  pid: number;
  /** Share of ONE core, as Electron reports it. */
  cpu: number;
  mb: number;
}

/**
 * What the MAIN process holds, split by kind. The per-process working set says
 * which process is heavy; this says what is heavy inside it, which is the
 * difference between "our JS retains it" (heap), "buffers/IPC payloads"
 * (external) and "Chromium/native" (rss with a small heap).
 */
export interface MainMemory {
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
}

export interface PerfReport {
  at: string;
  totalMb: number;
  processes: ProcSample[];
  main: MainMemory;
  /** Saved-state size and how many autosaves have run — the other way a long
   *  session grows: the whole history is written on every structural change. */
  state: { saves: number; bytes: number };
  /** Whether the GPU is doing the compositing, and what Chromium thinks of it. */
  gpu: Record<string, string>;
}

function sample(): PerfReport {
  const processes = app
    .getAppMetrics()
    .map((m) => ({
      type: m.type,
      pid: m.pid,
      cpu: Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10,
      mb: Math.round((m.memory?.workingSetSize ?? 0) / 1024),
    }))
    .sort((a, b) => b.mb - a.mb);
  let gpu: Record<string, string> = {};
  try {
    gpu = app.getGPUFeatureStatus() as unknown as Record<string, string>;
  } catch {
    // Not fatal: the report is still useful without the feature matrix.
  }
  const mb = (bytes: number): number => Math.round(bytes / (1024 * 1024));
  const m = process.memoryUsage();
  return {
    at: new Date().toISOString(),
    totalMb: processes.reduce((n, p) => n + p.mb, 0),
    processes,
    main: {
      rssMb: mb(m.rss),
      heapUsedMb: mb(m.heapUsed),
      heapTotalMb: mb(m.heapTotal),
      externalMb: mb(m.external),
      arrayBuffersMb: mb(m.arrayBuffers),
    },
    state: saveStats(),
    gpu,
  };
}

function line(report: PerfReport): string {
  const procs = report.processes.map((p) => `${p.type}#${p.pid} ${p.cpu}%cpu ${p.mb}MB`).join(" | ");
  const m = report.main;
  const main = `main rss ${m.rssMb}MB heap ${m.heapUsedMb}/${m.heapTotalMb}MB ext ${m.externalMb}MB ab ${m.arrayBuffersMb}MB`;
  const st = `state ${Math.round(report.state.bytes / 1024)}KB x${report.state.saves}`;
  return `total ${report.totalMb}MB | ${main} | ${st} | ${procs}`;
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastAlertAt = 0;

/** Start sampling. Idempotent; stops itself when the app quits. */
export function startPerfWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    const report = sample();
    const hot = report.processes.some((p) => p.cpu >= CPU_PCT_ALERT);
    const heavy = report.totalMb >= TOTAL_MB_ALERT;
    if (!hot && !heavy) return;
    const now = Date.now();
    if (now - lastAlertAt < ALERT_COOLDOWN_MS) return;
    lastAlertAt = now;
    log.warn(`perf: ${heavy ? "memory" : "cpu"} above threshold — ${line(report)}`);
  }, SAMPLE_MS);
  timer.unref?.();
  app.once("will-quit", stopPerfWatch);
}

export function stopPerfWatch(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * A snapshot the user can copy out of Settings and paste into a support ticket:
 * versions, the GPU feature matrix (an app compositing in software burns CPU for
 * every blinking caret) and the per-process split.
 */
export function perfReportText(): string {
  const report = sample();
  const gpu = Object.entries(report.gpu)
    .map(([k, v]) => `  ${k}: ${v}`)
    .join("\n");
  const uptimeMin = Math.round(process.uptime() / 60);
  return [
    `Wello Code ${app.getVersion()}`,
    `${process.platform} ${process.getSystemVersion?.() ?? ""} · Electron ${process.versions.electron} · ${process.arch}`,
    `Время: ${report.at} · приложение работает ${uptimeMin} мин`,
    `Аппаратное ускорение в настройках: ${hardwareAccelerationEnabledSync() ? "включено" : "выключено"}`,
    "",
    `Процессы (${report.totalMb} МБ всего):`,
    ...report.processes.map((p) => `  ${p.type} #${p.pid}: ${p.cpu}% CPU, ${p.mb} МБ`),
    "",
    "Главный процесс:",
    `  занято скриптами: ${report.main.heapUsedMb} из ${report.main.heapTotalMb} МБ`,
    `  буферы: ${report.main.externalMb} МБ (из них массивы ${report.main.arrayBuffersMb} МБ)`,
    `  всего у процесса: ${report.main.rssMb} МБ`,
    `  сохранений истории: ${report.state.saves}, последняя запись ${Math.round(report.state.bytes / 1024)} КБ`,
    "",
    "Графика:",
    gpu || "  нет данных",
  ].join("\n");
}
