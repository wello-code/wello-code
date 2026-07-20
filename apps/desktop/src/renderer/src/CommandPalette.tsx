import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";
import { useOverlayMark } from "./overlay-signal";
import { useFocusTrap } from "./use-focus-trap";

/**
 * Command palette (Ctrl/Cmd+K) — the single keyboard entry point, like Claude Code
 * and modern IDEs. Fuzzy-filters a flat list of actions plus a "jump to chat"
 * section, navigable with ↑/↓/Enter/Esc. Actions are supplied by App (which holds
 * the state), so this stays a dumb, reusable overlay.
 */

export interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  icon?: IconName;
  /** Extra words to match on (not shown). */
  keywords?: string;
  run: () => void;
}

interface Row {
  key: string;
  label: string;
  hint?: string;
  icon?: IconName;
  run: () => void;
}

export function CommandPalette({
  commands,
  tasks,
  onSwitchTask,
  onClose,
}: {
  commands: PaletteCommand[];
  tasks: { id: string; title: string }[];
  onSwitchTask: (id: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useFocusTrap(cardRef);
  useOverlayMark();

  const rows: Row[] = useMemo(() => {
    const query = q.trim().toLowerCase();
    const has = (s: string | undefined): boolean => !!s && s.toLowerCase().includes(query);
    const match = (c: PaletteCommand): boolean =>
      !query || has(c.label) || has(c.hint) || has(c.keywords);
    const cmdRows: Row[] = commands
      .filter(match)
      .map((c) => ({ key: `cmd:${c.id}`, label: c.label, hint: c.hint, icon: c.icon, run: c.run }));
    const taskRows: Row[] = tasks
      .filter((t) => !query || t.title.toLowerCase().includes(query))
      .slice(0, 8)
      .map((t) => ({
        key: `task:${t.id}`,
        label: t.title,
        hint: "Перейти к чату",
        icon: "compose" as IconName,
        run: () => onSwitchTask(t.id),
      }));
    return [...cmdRows, ...taskRows];
  }, [q, commands, tasks, onSwitchTask]);

  // Keep the selection valid as the list shrinks.
  useEffect(() => {
    setIdx((i) => Math.min(i, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  // Keep the highlighted row in view.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const run = (r: Row | undefined): void => {
    if (!r) return;
    onClose();
    r.run();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIdx((i) => (rows.length ? (i + 1) % rows.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIdx((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(rows[idx]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="palette"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="palette__card wello-rise"
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label="Палитра команд"
        onKeyDown={onKeyDown}
      >
        <div className="palette__search">
          <Icon name="search" size={15} />
          <input
            className="palette__input"
            placeholder="Команда или чат…"
            value={q}
            autoFocus
            spellCheck={false}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
          />
          <kbd className="palette__esc">Esc</kbd>
        </div>
        <div className="palette__list" ref={listRef} role="listbox" aria-label="Команды">
          {rows.length === 0 ? (
            <p className="palette__empty">Ничего не найдено</p>
          ) : (
            rows.map((r, i) => (
              <button
                key={r.key}
                type="button"
                role="option"
                aria-selected={i === idx}
                data-i={i}
                className={`palette__row ${i === idx ? "is-active" : ""}`}
                onMouseEnter={() => setIdx(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => run(r)}
              >
                {r.icon ? <Icon name={r.icon} size={14} /> : <span className="palette__dot" aria-hidden />}
                <span className="palette__label">{r.label}</span>
                {r.hint ? <span className="palette__hint">{r.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
