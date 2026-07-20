import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, screen, type BrowserWindow, type Rectangle } from "electron";

/**
 * Remembers the window's size and position across restarts (Electron doesn't do
 * this itself — every launch would otherwise reopen at the default 1280×800).
 * Persisted synchronously-readable on startup, saved debounced on resize/move.
 */
export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized?: boolean;
}

const DEFAULT_BOUNDS: WindowBounds = { width: 1280, height: 800 };
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;

function boundsPath(): string {
  return join(app.getPath("userData"), "wello-window.json");
}

/**
 * A saved rect is usable only if it still lands on a connected display — a
 * monitor can be unplugged between sessions, stranding the window off-screen.
 * Requires a real overlap (not just a shared edge) with some display's work area.
 */
export function boundsOnScreen(
  bounds: WindowBounds,
  displays: Array<{ workArea: Rectangle }>,
): boolean {
  if (bounds.x === undefined || bounds.y === undefined) return true; // size-only: centered, always fine
  return displays.some((d) => {
    const a = d.workArea;
    const overlapX = Math.max(0, Math.min(bounds.x! + bounds.width, a.x + a.width) - Math.max(bounds.x!, a.x));
    const overlapY = Math.max(0, Math.min(bounds.y! + bounds.height, a.y + a.height) - Math.max(bounds.y!, a.y));
    // At least a 64px corner visible so the titlebar can be grabbed.
    return overlapX >= 64 && overlapY >= 64;
  });
}

/** Load usable bounds (synchronous — createWindow needs them before showing). */
export function loadWindowBounds(): WindowBounds {
  try {
    const raw = readFileSync(boundsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<WindowBounds>;
    const width = Math.max(MIN_WIDTH, Math.round(Number(parsed.width) || DEFAULT_BOUNDS.width));
    const height = Math.max(MIN_HEIGHT, Math.round(Number(parsed.height) || DEFAULT_BOUNDS.height));
    const bounds: WindowBounds = {
      width,
      height,
      ...(Number.isFinite(parsed.x) ? { x: Math.round(parsed.x!) } : {}),
      ...(Number.isFinite(parsed.y) ? { y: Math.round(parsed.y!) } : {}),
      ...(parsed.maximized ? { maximized: true } : {}),
    };
    return boundsOnScreen(bounds, screen.getAllDisplays()) ? bounds : { width, height };
  } catch {
    return { ...DEFAULT_BOUNDS };
  }
}

let writing = Promise.resolve();
function persist(bounds: WindowBounds): void {
  writing = writing.then(async () => {
    try {
      const target = boundsPath();
      if (!existsSync(dirname(target))) await mkdir(dirname(target), { recursive: true });
      const tmp = target + ".tmp";
      await writeFile(tmp, JSON.stringify(bounds), "utf8");
      await rename(tmp, target);
    } catch {
      // Best-effort — a lost bounds write just reopens where it last succeeded.
    }
  });
}

/**
 * Wire a window's resize/move/maximize to the store (debounced). While maximized
 * we keep the last NORMAL rect (getNormalBounds) so un-maximizing after a restart
 * restores a sensible floating size, not a full-screen one.
 */
export function trackWindowBounds(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  const save = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (win.isDestroyed()) return;
      const normal = win.getNormalBounds();
      persist({
        x: normal.x,
        y: normal.y,
        width: normal.width,
        height: normal.height,
        maximized: win.isMaximized(),
      });
    }, 400);
    timer.unref?.();
  };
  win.on("resize", save);
  win.on("move", save);
  win.on("maximize", save);
  win.on("unmaximize", save);
}
