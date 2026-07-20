import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { SubagentInfo } from "./agent-state";
import { ReviewPane } from "./Changes";
import {
  computeDock,
  type DockSep,
  loadDockPrefs,
  saveDockPrefs,
  TILE_MIN_H,
  TILE_MIN_W,
} from "./dock-layout";
import { Icon, type IconName } from "./Icon";
import { AgentsPanel, FilePane, PreviewPane } from "./Inspector";
import { TerminalPanel } from "./Terminal";

/**
 * The right-hand PANEL DOCK, Claude Code style: one column spanning the whole
 * work area (titlebar to bottom) that TILES every open tool — review,
 * subagents, preview, files, terminal. One panel fills the dock; two split it
 * 50/50; three-four form a two-column grid when the dock is wide enough. Thin
 * draggable rails divide the tiles, the dock's left edge drags its width, and
 * the ⤢ button gives one tile the whole dock. Tiles are positioned absolutely
 * from dock-layout.ts and NEVER remount on layout changes — the terminal keeps
 * its shell, the preview keeps its page.
 */

export type PanelId = "review" | "agents" | "preview" | "terminal" | `file:${string}`;

export const DOCK_MIN = 320;
/** Keep at least this much for the sidebar+editor when dragging the dock wider. */
const EDITOR_RESERVE = 560;

function fileName(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? path : path.slice(idx + 1);
}

function panelMeta(id: PanelId): { icon: IconName; title: string; hint?: string } {
  if (id === "review") return { icon: "shieldcheck", title: "Проверка" };
  if (id === "agents") return { icon: "subagent", title: "Субагенты" };
  if (id === "preview") return { icon: "globe", title: "Превью" };
  if (id === "terminal") return { icon: "terminal", title: "Терминал" };
  const path = id.slice(5);
  return { icon: "file", title: fileName(path), hint: path };
}

interface SepDrag {
  sep: DockSep;
  startX: number;
  startY: number;
  /** Pixel snapshot of every tile in the rail's column (row rails). */
  column: Record<string, number>;
  aPx: number;
  bPx: number;
  /** Dock width at drag start (column rails). */
  dockW: number;
  /** What the drag settled on — persisted once on pointer-up. */
  final: { split?: number; weights?: Record<string, number> };
}

export function PanelDock({
  panels,
  maximized,
  width,
  workspacePath,
  taskId,
  refreshKey,
  subagents,
  model,
  onCaptureScreenshot,
  onOpenFile,
  onClosePanel,
  onToggleMax,
  onResize,
  onResizeEnd,
  onRepoChanged,
}: {
  panels: PanelId[];
  maximized: PanelId | null;
  width: number;
  workspacePath: string;
  taskId: string;
  refreshKey: number;
  subagents: SubagentInfo[];
  /** The composer's current model — the commit-message generator uses it. */
  model: string;
  onCaptureScreenshot: (path: string) => void;
  onOpenFile: (path: string) => void;
  onClosePanel: (id: PanelId) => void;
  onToggleMax: (id: PanelId) => void;
  onResize: (width: number) => void;
  /** Receives the FINAL width (tracked in the drag ref — render props can lag a fast drag). */
  onResizeEnd: (width: number) => void;
  /** The repo state changed under the review pane (init / commit) — refresh the chip/card. */
  onRepoChanged: () => void;
}) {
  const hostRef = useRef<HTMLElement>(null);
  // The dock is measured, not trusted: the CSS width is clamped by the viewport
  // (min(saved, 100vw-…)), so the actual box is the only honest layout input.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [split, setSplit] = useState<number>(() => {
    const s = loadDockPrefs().split;
    return typeof s === "number" && s > 0 && s < 1 ? s : 0.5;
  });
  const [weights, setWeights] = useState<Record<string, number>>(
    () => loadDockPrefs().weights ?? {},
  );

  const measure = useCallback((): void => {
    const el = hostRef.current;
    if (el) setSize({ w: el.clientWidth, h: el.clientHeight });
  }, []);
  useLayoutEffect(() => {
    measure();
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  // ResizeObserver delivery rides the frame pipeline — a hidden window produces
  // no frames, so a width-drag there would tile against a stale size. The width
  // prop is the drag's own signal; re-measuring on it keeps the two in lockstep.
  useLayoutEffect(measure, [measure, width]);

  const layout = size
    ? computeDock({ panels, width: size.w, height: size.h, maximized, split, weights })
    : null;

  /* ── Left edge: dock width ─────────────────────────────────────────────── */

  // The native preview browser is an OS surface OVER the dock — pointer events
  // above it never reach the renderer, so a drag that crosses it would freeze.
  // Every dock drag announces itself on the overlay channel: the preview pane
  // hides the surface for the drag and restores it (at the new rect) on release.
  const dragOverlayRef = useRef(false);
  const dockDragStart = useCallback(() => {
    if (dragOverlayRef.current) return;
    dragOverlayRef.current = true;
    window.dispatchEvent(new Event("wello-overlay-open"));
  }, []);
  const dockDragEnd = useCallback(() => {
    if (!dragOverlayRef.current) return;
    dragOverlayRef.current = false;
    window.dispatchEvent(new Event("wello-overlay-close"));
  }, []);

  const dragRef = useRef<{ startX: number; startW: number; lastW: number } | null>(null);

  const onGripDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      dragRef.current = { startX: e.clientX, startW: width, lastW: width };
      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* synthetic events (tests) have no active pointer */
      }
      document.body.classList.add("is-col-resizing");
      dockDragStart();
    },
    [width, dockDragStart],
  );
  const onGripMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const d = dragRef.current;
      if (!d) return;
      const max = Math.max(DOCK_MIN, window.innerWidth - EDITOR_RESERVE);
      const next = Math.min(max, Math.max(DOCK_MIN, d.startW + (d.startX - e.clientX)));
      d.lastW = next;
      onResize(next);
    },
    [onResize],
  );
  const onGripUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      const finalW = dragRef.current.lastW;
      dragRef.current = null;
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* nothing captured */
      }
      document.body.classList.remove("is-col-resizing");
      dockDragEnd();
      onResizeEnd(finalW);
    },
    [onResizeEnd, dockDragEnd],
  );

  /* ── Rails between tiles ───────────────────────────────────────────────── */

  const sepRef = useRef<SepDrag | null>(null);

  const onSepDown = (sep: DockSep) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (!layout || !size) return;
    const column: Record<string, number> = {};
    if (sep.kind === "row") {
      // Snapshot the WHOLE column in pixels: the pair being dragged gets pixel
      // values, and mixing scales inside one column would warp its neighbours.
      for (const id of sep.column ?? []) column[id] = layout.rects[id]?.height ?? TILE_MIN_H;
    }
    sepRef.current = {
      sep,
      startX: e.clientX,
      startY: e.clientY,
      column,
      aPx: (sep.kind === "row" ? layout.rects[sep.a]?.height : layout.rects[sep.a]?.width) ?? 0,
      bPx: (sep.kind === "row" ? layout.rects[sep.b]?.height : layout.rects[sep.b]?.width) ?? 0,
      dockW: size.w,
      final: {},
    };
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events (tests) have no active pointer */
    }
    e.currentTarget.classList.add("is-drag");
    document.body.classList.add(sep.kind === "row" ? "is-row-resizing" : "is-col-resizing");
    dockDragStart();
  };

  const onSepMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = sepRef.current;
    if (!d) return;
    if (d.sep.kind === "col") {
      if (d.dockW < TILE_MIN_W * 2) return;
      const a = Math.min(
        d.dockW - TILE_MIN_W,
        Math.max(TILE_MIN_W, d.aPx + (e.clientX - d.startX)),
      );
      d.final.split = a / d.dockW;
      setSplit(d.final.split);
    } else {
      const pair = d.aPx + d.bPx;
      if (pair < TILE_MIN_H * 2) return;
      const a = Math.min(pair - TILE_MIN_H, Math.max(TILE_MIN_H, d.aPx + (e.clientY - d.startY)));
      d.final.weights = { ...weights, ...d.column, [d.sep.a]: a, [d.sep.b]: pair - a };
      setWeights(d.final.weights);
    }
  };

  const onSepUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = sepRef.current;
    if (!d) return;
    sepRef.current = null;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* nothing captured */
    }
    e.currentTarget.classList.remove("is-drag");
    document.body.classList.remove("is-row-resizing");
    document.body.classList.remove("is-col-resizing");
    dockDragEnd();
    if (d.final.split !== undefined || d.final.weights !== undefined) saveDockPrefs(d.final);
  };

  const runningAgents = subagents.filter((s) => s.status === "running").length;

  return (
    <aside className="dock" aria-label="Панели" ref={hostRef}>
      <div
        className="dock__grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Изменить ширину панелей"
        onPointerDown={onGripDown}
        onPointerMove={onGripMove}
        onPointerUp={onGripUp}
        onPointerCancel={onGripUp}
      />
      {panels.map((id) => {
        const rect = layout?.rects[id] ?? null;
        // Hidden tiles (another one is maximized, or the first un-measured
        // frame) keep their DOM — display:none never restarts a shell or
        // reloads the preview.
        const style: React.CSSProperties = rect
          ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
          : { display: "none" };
        if (id === "terminal") {
          return (
            <TerminalPanel
              key={`terminal:${workspacePath}`}
              cwd={workspacePath}
              style={style}
              hidden={!rect}
              maximized={maximized === id}
              onToggleMax={() => onToggleMax(id)}
              onClose={() => onClosePanel(id)}
            />
          );
        }
        const meta = panelMeta(id);
        return (
          <section key={id} className="panel" style={style} aria-label={meta.title}>
            <header className="panel__bar" title={meta.hint}>
              <Icon name={meta.icon} size={13} />
              <span className="panel__title">{meta.title}</span>
              {id === "agents" && runningAgents > 0 ? (
                <span className="panel__count">{runningAgents}</span>
              ) : null}
              <span className="inspector__spacer" />
              <button
                className="icon-button"
                title={maximized === id ? "Вернуть плитки" : "Развернуть на весь док"}
                aria-label={
                  maximized === id ? "Вернуть плитки" : `Развернуть на весь док: ${meta.title}`
                }
                aria-pressed={maximized === id}
                onClick={() => onToggleMax(id)}
              >
                <Icon name={maximized === id ? "collapse" : "expand"} size={14} />
              </button>
              <button
                className="icon-button"
                title="Закрыть панель"
                aria-label={`Закрыть: ${meta.title}`}
                onClick={() => onClosePanel(id)}
              >
                <Icon name="x" size={14} />
              </button>
            </header>
            <div className="panel__body">
              {id === "review" ? (
                <ReviewPane
                  workspacePath={workspacePath}
                  taskId={taskId}
                  refreshKey={refreshKey}
                  model={model}
                  onOpenFile={onOpenFile}
                  onRepoChanged={onRepoChanged}
                />
              ) : id === "agents" ? (
                <AgentsPanel subagents={subagents} />
              ) : id === "preview" ? (
                <PreviewPane
                  key={workspacePath}
                  workspacePath={workspacePath}
                  active
                  onCapture={onCaptureScreenshot}
                />
              ) : (
                <FilePane workspacePath={workspacePath} path={id.slice(5)} />
              )}
            </div>
          </section>
        );
      })}
      {(layout?.seps ?? []).map((sep) => (
        <div
          key={`${sep.kind}:${sep.a}|${sep.b}`}
          className={`dock__sep dock__sep--${sep.kind}`}
          role="separator"
          aria-orientation={sep.kind === "row" ? "horizontal" : "vertical"}
          aria-label={sep.kind === "row" ? "Изменить высоту панелей" : "Изменить ширину колонок"}
          style={{
            left: sep.rect.left,
            top: sep.rect.top,
            width: sep.rect.width,
            height: sep.rect.height,
          }}
          onPointerDown={onSepDown(sep)}
          onPointerMove={onSepMove}
          onPointerUp={onSepUp}
          onPointerCancel={onSepUp}
        />
      ))}
    </aside>
  );
}
