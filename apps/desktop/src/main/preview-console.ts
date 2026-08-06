/**
 * Pure console-tail logic for the preview pane (no electron import → testable).
 * preview-view feeds raw console events in; preview_look reads the tail out.
 */

/** Warnings and errors only: they are what a fix needs, and chatty pages would
 *  flush real problems out of a small tail with plain log() noise. */
export function consoleLine(level: unknown, message: unknown, cap = 300): string | null {
  const levels: Record<string, string> = {
    "0": "log",
    "1": "log",
    "2": "warn",
    "3": "error",
    verbose: "log",
    info: "log",
    log: "log",
    debug: "log",
    warning: "warn",
    warn: "warn",
    error: "error",
  };
  const kind = levels[String(level)] ?? "log";
  if (kind === "log") return null;
  const text = String(message ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return `[${kind}] ${text.slice(0, cap)}`;
}

/** A bounded rolling tail (oldest first). */
export class ConsoleTail {
  private readonly lines: string[] = [];
  constructor(private readonly max = 60) {}

  push(line: string | null): void {
    if (!line) return;
    this.lines.push(line);
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }

  snapshot(): string[] {
    return [...this.lines];
  }
}
