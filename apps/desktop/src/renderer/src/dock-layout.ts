/**
 * Pure tiling math for the right-hand panel DOCK (Claude Code style).
 *
 * The dock fills the work area and lays the open panels out as TILES divided
 * by thin draggable rails:
 *   1 panel  → the whole dock;
 *   2 panels → one column, two rows (50/50 by default);
 *   3–4      → a two-column grid when the dock is ≥ TWO_COL_MIN wide (2×2 for
 *              four; for three the first column stacks two and the second is
 *              one full-height tile); a narrower dock stays single-column with
 *              equal heights. More panels keep extending the same halves.
 *
 * Sizes come from per-panel weights (relative WITHIN a column — scales never
 * mix across columns) plus a column-split fraction; every tile is clamped to
 * TILE_MIN_* so nothing can be dragged or squeezed into an unusable sliver.
 * The component renders tiles as absolutely-positioned siblings from these
 * rects, so layout changes never remount a panel (the terminal keeps its
 * shell, the preview keeps its page).
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DockSep {
  kind: "row" | "col";
  /** The tiles the rail sits between (row: above/below; col: first of each column). */
  a: string;
  b: string;
  /** Row rails only: every panel of the column, for pixel-snapshotting a drag. */
  column?: string[];
  rect: Rect;
}

export interface DockLayout {
  /** Tile rect per open panel; null = stays mounted but hidden (another tile is maximized). */
  rects: Record<string, Rect | null>;
  seps: DockSep[];
  columns: string[][];
}

export const TILE_MIN_H = 200;
export const TILE_MIN_W = 280;
/** Dock width from which 3-4 panels form a two-column grid. */
export const TWO_COL_MIN = 560;
/** Hit size of a drag rail; the visible hairline is drawn centered inside it. */
export const SEP_SIZE = 7;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Column assignment: first ⌈n/2⌉ panels stack in column A, the rest in B. */
export function columnsFor(panels: string[], width: number): string[][] {
  if (panels.length === 0) return [];
  if (panels.length >= 3 && width >= TWO_COL_MIN) {
    const cut = Math.ceil(panels.length / 2);
    return [panels.slice(0, cut), panels.slice(cut)];
  }
  return [panels.slice()];
}

/**
 * Split `total` px between weighted items with nobody below `min`: proportional
 * shares first, then anyone under the floor is pinned to it and the rest is
 * redistributed (repeats until stable). When even the floors don't fit, all
 * items squeeze equally — predictable, and the rails simply stop dragging.
 */
export function distribute(total: number, weights: number[], min: number): number[] {
  const n = weights.length;
  if (n === 0) return [];
  if (total <= min * n) return weights.map(() => total / n);
  const out = new Array<number>(n).fill(0);
  const fixed = new Set<number>();
  for (let pass = 0; pass <= n; pass++) {
    const rem = total - fixed.size * min;
    const free = weights.map((_, i) => i).filter((i) => !fixed.has(i));
    const sum = free.reduce((s, i) => s + Math.max(weights[i] ?? 1, 0.0001), 0);
    let pinned = false;
    for (const i of free) {
      if ((rem * Math.max(weights[i] ?? 1, 0.0001)) / sum < min) {
        fixed.add(i);
        out[i] = min;
        pinned = true;
      }
    }
    if (!pinned) {
      for (const i of free) out[i] = (rem * Math.max(weights[i] ?? 1, 0.0001)) / sum;
      break;
    }
  }
  return out;
}

export function computeDock(args: {
  panels: string[];
  width: number;
  height: number;
  maximized: string | null;
  /** Column A's share of the dock width when two columns are laid out (0..1). */
  split: number;
  weights: Record<string, number>;
}): DockLayout {
  const { panels, width, height, maximized, split, weights } = args;
  const rects: Record<string, Rect | null> = {};

  // A maximized tile takes the whole dock; the rest stay mounted but hidden.
  if (maximized && panels.includes(maximized)) {
    for (const id of panels) rects[id] = null;
    rects[maximized] = { left: 0, top: 0, width, height };
    return { rects, seps: [], columns: [panels.slice()] };
  }

  const columns = columnsFor(panels, width);
  const seps: DockSep[] = [];
  const colWidths =
    columns.length === 2
      ? (() => {
          const a = clamp(split * width, TILE_MIN_W, width - TILE_MIN_W);
          return [a, width - a];
        })()
      : [width];

  let x = 0;
  columns.forEach((col, ci) => {
    const w = colWidths[ci]!;
    // A panel with no stored weight joins at the column's MEAN weight (weights
    // may be pixel-scaled after a drag — a literal default of 1 would open the
    // newcomer as a sliver).
    const stored = col.map((id) => weights[id]);
    const present = stored.filter((v): v is number => typeof v === "number" && v > 0);
    const fallback = present.length > 0 ? present.reduce((s, v) => s + v, 0) / present.length : 1;
    const ws = stored.map((v) => (typeof v === "number" && v > 0 ? v : fallback));
    const hs = distribute(height, ws, TILE_MIN_H);

    let y = 0;
    col.forEach((id, ri) => {
      const h = hs[ri]!;
      rects[id] = { left: x, top: y, width: w, height: h };
      if (ri > 0) {
        seps.push({
          kind: "row",
          a: col[ri - 1]!,
          b: id,
          column: col,
          rect: { left: x, top: y - SEP_SIZE / 2, width: w, height: SEP_SIZE },
        });
      }
      y += h;
    });
    if (ci === 1) {
      seps.push({
        kind: "col",
        a: columns[0]![0]!,
        b: col[0]!,
        rect: { left: x - SEP_SIZE / 2, top: 0, width: SEP_SIZE, height },
      });
    }
    x += w;
  });

  return { rects, seps, columns };
}

/* ── Persistence (localStorage, same store the rest of the UI prefs use) ───── */

export interface DockPrefs {
  /** Dock width, px. */
  w?: number;
  /** Column-split fraction (column A's share). */
  split?: number;
  /** Per-panel size weights (relative within a column). */
  weights?: Record<string, number>;
  /** The open panel set (tool panels only — file tabs are workspace-bound). */
  panels?: string[];
  /** The maximized panel, if any. */
  max?: string | null;
}

export const DOCK_LS = "wello-code-dock-v1";
/** Pre-dock builds stored just the stack width — honored as a fallback once. */
const LEGACY_WIDTH_LS = "wello-code-stack-w";

const TOOL_PANELS = new Set(["review", "agents", "preview", "terminal"]);

/** The restorable subset of a saved panel set: known tool panels, deduped
 *  (file: tabs are dropped — their paths belong to whatever workspace was open). */
export function restorablePanels(prefs: DockPrefs): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of prefs.panels ?? []) {
    if (TOOL_PANELS.has(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

export function loadDockPrefs(): DockPrefs {
  try {
    const raw = localStorage.getItem(DOCK_LS);
    const prefs: DockPrefs = raw ? (JSON.parse(raw) as DockPrefs) : {};
    if (typeof prefs.w !== "number") {
      const legacy = Number(localStorage.getItem(LEGACY_WIDTH_LS));
      if (Number.isFinite(legacy) && legacy > 0) prefs.w = legacy;
    }
    return prefs;
  } catch {
    return {};
  }
}

export function saveDockPrefs(patch: Partial<DockPrefs>): void {
  try {
    localStorage.setItem(DOCK_LS, JSON.stringify({ ...loadDockPrefs(), ...patch }));
  } catch {
    /* storage full/unavailable — layout just won't persist */
  }
}
