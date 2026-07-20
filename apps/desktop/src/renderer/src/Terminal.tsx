import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { matchHotkey } from "./hotkeys";
import { Icon } from "./Icon";
import { toast } from "./Toaster";
import { parsePromptLine, TermBuffer, type TermSpan } from "./terminal-render";

/** Copy/clear of the ACTIVE session, surfaced to the panel's shared toolbar. */
interface SessionActions {
  copy: () => void;
  clear: () => void;
}

/** What a session reports upward for its tab (title/tooltip/error dot). */
interface TabPatch {
  /** Shell short name (cmd/powershell/bash) — known once the session spawns. */
  shell?: string;
  /** First word of the command in flight; null = back at the prompt. */
  running?: string | null;
  /** Current directory parsed from the resting prompt (tooltip). */
  cwd?: string | null;
  /** Shell exit code (null clears the error dot). */
  exit?: number | null;
}

interface TabInfo {
  key: number;
  shell: string | null;
  running: string | null;
  cwd: string | null;
  exit: number | null;
}

/** Tab title by priority: foreground command → shell name → «Терминал N». */
function tabTitle(t: TabInfo, index: number): string {
  return t.running ?? t.shell ?? `Терминал ${index + 1}`;
}

/**
 * The terminal tile of the right-hand PanelDock (Claude Code style): a slim
 * header — title, session tabs, «+» for another shell, copy/clear on hover,
 * maximize and close. Each tab is its own persistent shell; inactive sessions
 * stay MOUNTED (display:none) so their buffers and processes live on. When
 * another tile is maximized the whole panel goes `hidden` (display:none via
 * `style`) — again with everything alive underneath.
 *
 * The output is a CUSTOM renderer (terminal-render.ts), not xterm: the shell
 * stream is parsed into styled lines and drawn as ordinary DOM with the app's
 * own fonts and colour tokens, so the panel is native to the IDE — same
 * typography as everything else, native selection/copy, theme-aware for free.
 */
export function TerminalPanel({
  cwd,
  style,
  hidden,
  maximized,
  onToggleMax,
  onClose,
}: {
  cwd: string;
  /** Tile rect from the dock (or display:none while hidden/unmeasured). */
  style: React.CSSProperties;
  hidden: boolean;
  maximized: boolean;
  onToggleMax: () => void;
  onClose: () => void;
}) {
  const [tabs, setTabs] = useState<TabInfo[]>([
    { key: 1, shell: null, running: null, cwd: null, exit: null },
  ]);
  const [active, setActiveKey] = useState(1);
  const nextKey = useRef(2);
  const actionsRef = useRef<SessionActions | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const tabsRowRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLSpanElement>(null);
  // Edge fades hint at more tabs beyond the strip's edges.
  const [fadeL, setFadeL] = useState(false);
  const [fadeR, setFadeR] = useState(false);

  const reportTab = (key: number, patch: TabPatch): void => {
    setTabs((ts) =>
      ts.map((t) =>
        t.key === key
          ? {
              ...t,
              ...(patch.shell !== undefined ? { shell: patch.shell } : null),
              ...(patch.running !== undefined ? { running: patch.running } : null),
              ...(patch.cwd !== undefined ? { cwd: patch.cwd } : null),
              ...(patch.exit !== undefined ? { exit: patch.exit } : null),
            }
          : t,
      ),
    );
  };

  /** Activating a tab also acknowledges its error dot. */
  const setActive = (key: number): void => {
    setActiveKey(key);
    setTabs((ts) => ts.map((t) => (t.key === key && t.exit != null ? { ...t, exit: null } : t)));
  };

  const addTab = (): void => {
    const key = nextKey.current++;
    setTabs((t) => [...t, { key, shell: null, running: null, cwd: null, exit: null }]);
    setActiveKey(key);
  };

  const closeTab = (key: number): void => {
    setTabs((t) => {
      const next = t.filter((x) => x.key !== key);
      if (next.length === 0) {
        // Closing the last session closes the panel itself.
        onClose();
        return t;
      }
      // Closing the active tab lands on its LEFT neighbour.
      if (key === active) {
        const idx = t.findIndex((x) => x.key === key);
        setActiveKey((next[Math.max(0, idx - 1)] ?? next[0]!).key);
      }
      return next;
    });
  };

  // Ctrl+Tab (shared registry, scoped): next tab — only while the terminal
  // panel owns the focus, so it can't hijack the chord app-wide.
  const cycleRef = useRef<() => void>(() => {});
  cycleRef.current = () => {
    const idx = tabs.findIndex((t) => t.key === active);
    const next = tabs[(idx + 1) % tabs.length];
    if (next) setActive(next.key);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (matchHotkey(e) !== "termNext") return;
      const root = rootRef.current;
      if (!root || !root.contains(document.activeElement)) return;
      e.preventDefault();
      cycleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Overflowed strip: keep the active tab in view + maintain the edge fades.
  const updateFades = (): void => {
    const el = tabsRowRef.current;
    if (!el) {
      setFadeL(false);
      setFadeR(false);
      return;
    }
    setFadeL(el.scrollLeft > 2);
    setFadeR(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  };
  useLayoutEffect(() => {
    activeTabRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
    updateFades();
  }, [active, tabs.length]);

  return (
    <section className="panel terminal" style={style} aria-label="Терминал" ref={rootRef}>
      <header className="panel__bar terminal__bar">
        <Icon name="terminal" size={13} />
        <span className="panel__title">Терминал</span>
        {tabs.length > 1 ? (
          <div
            className={`terminal__tabs ${fadeL ? "is-fade-l" : ""} ${fadeR ? "is-fade-r" : ""}`}
            ref={tabsRowRef}
            role="tablist"
            aria-label="Сессии терминала"
            onScroll={updateFades}
            onWheel={(e) => {
              // The strip scrolls horizontally with a plain wheel.
              if (e.deltaY !== 0 && tabsRowRef.current) {
                tabsRowRef.current.scrollLeft += e.deltaY;
              }
            }}
            onDoubleClick={(e) => {
              // Double-click on the EMPTY part of the strip = a new session.
              if (e.target === e.currentTarget) addTab();
            }}
          >
            {tabs.map((t, i) => {
              const title = tabTitle(t, i);
              return (
                <span
                  key={t.key}
                  role="tab"
                  aria-selected={t.key === active}
                  ref={t.key === active ? activeTabRef : undefined}
                  className={`terminal__tab ${t.key === active ? "is-active" : ""}`}
                  title={t.cwd ? `${title} — ${t.cwd}` : title}
                  onClick={() => setActive(t.key)}
                  onAuxClick={(e) => {
                    // Middle mouse closes, the terminal-tab convention.
                    if (e.button === 1) {
                      e.preventDefault();
                      closeTab(t.key);
                    }
                  }}
                >
                  {t.exit != null && t.exit !== 0 && t.key !== active ? (
                    <span className="terminal__tab-dot" title="Процесс завершился с ошибкой" />
                  ) : null}
                  <span className="terminal__tab-title">{title}</span>
                  <button
                    className="terminal__tab-x"
                    title="Закрыть сессию"
                    aria-label={`Закрыть сессию ${i + 1}`}
                    tabIndex={t.key === active ? 0 : -1}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.key);
                    }}
                  >
                    <Icon name="x" size={9} />
                  </button>
                </span>
              );
            })}
          </div>
        ) : null}
        <button
          className="icon-button terminal__new"
          title="Новый терминал"
          aria-label="Новый терминал"
          onClick={addTab}
        >
          <Icon name="plus" size={14} />
        </button>
        <span className="inspector__spacer" />
        {/* Utility actions fade in on hover/focus — the resting header stays as
            clean as the reference: title, «+», expand, close. */}
        <button
          className="icon-button terminal__tool"
          title="Копировать вывод"
          aria-label="Копировать вывод терминала"
          onClick={() => actionsRef.current?.copy()}
        >
          <Icon name="copy" size={14} />
        </button>
        <button
          className="icon-button terminal__tool"
          title="Очистить (Ctrl+L)"
          aria-label="Очистить терминал"
          onClick={() => actionsRef.current?.clear()}
        >
          <Icon name="trash" size={14} />
        </button>
        <button
          className="icon-button"
          title={maximized ? "Вернуть плитки" : "Развернуть на весь док"}
          aria-label={maximized ? "Вернуть плитки" : "Развернуть на весь док: Терминал"}
          aria-pressed={maximized}
          onClick={onToggleMax}
        >
          <Icon name={maximized ? "collapse" : "expand"} size={14} />
        </button>
        <button
          className="icon-button"
          title="Закрыть терминал (Ctrl+`)"
          aria-label="Закрыть терминал"
          onClick={onClose}
        >
          <Icon name="x" size={14} />
        </button>
      </header>
      {tabs.map((t) => (
        <TerminalSession
          key={t.key}
          cwd={cwd}
          visible={t.key === active && !hidden}
          report={(patch) => reportTab(t.key, patch)}
          register={(a) => {
            if (a) actionsRef.current = a;
          }}
        />
      ))}
    </section>
  );
}

/** One styled line; memoised — the span array is reference-stable while unchanged. */
const TermLine = memo(function TermLine({ spans }: { spans: TermSpan[] }) {
  if (spans.length === 0) return <div className="termout__line"> </div>;
  return (
    <div className="termout__line">
      {spans.map((s, i) =>
        s.style ? (
          <span key={i} className={spanClass(s)} style={spanStyle(s)}>
            {s.text}
          </span>
        ) : (
          s.text
        ),
      )}
    </div>
  );
});

function spanClass(s: TermSpan): string | undefined {
  const st = s.style!;
  const cls: string[] = [];
  if (st.fg?.startsWith("a")) cls.push(`tfg-${st.fg.slice(1)}`);
  if (st.bg?.startsWith("a")) cls.push(`tbg-${st.bg.slice(1)}`);
  if (st.bold) cls.push("t-bold");
  if (st.dim) cls.push("t-dim");
  if (st.italic) cls.push("t-italic");
  if (st.underline) cls.push("t-underline");
  return cls.length ? cls.join(" ") : undefined;
}

function spanStyle(s: TermSpan): React.CSSProperties | undefined {
  const st = s.style!;
  const css: React.CSSProperties = {};
  if (st.fg?.startsWith("#")) css.color = st.fg;
  if (st.bg?.startsWith("#")) css.backgroundColor = st.bg;
  return css.color || css.backgroundColor ? css : undefined;
}

/**
 * One shell session backed by the main-process TerminalManager. There's no PTY
 * (node-pty needs a native toolchain the target may lack), so rather than fight
 * a piped shell's echo, the model is clean: the output view is READ-ONLY (the
 * shell's own prompt + echoed command + output), and a dedicated input line
 * below sends whole commands. Full editing + history in the input. Good for
 * commands (git/npm/builds); not for full-screen TUIs.
 */
function TerminalSession({
  cwd,
  visible,
  report,
  register,
}: {
  cwd: string;
  visible: boolean;
  /** Tab metadata channel: shell name, in-flight command, prompt cwd, exit. */
  report: (patch: TabPatch) => void;
  /** Hands the panel this session's copy/clear when it becomes the active tab. */
  register: (actions: SessionActions | null) => void;
}) {
  const bufRef = useRef<TermBuffer | null>(null);
  if (!bufRef.current) bufRef.current = new TermBuffer();
  const buf = bufRef.current;

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  // Read by the data handler so a HIDDEN tab keeps buffering without repainting.
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const idRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyRef = useRef<string[]>([]);
  const rafRef = useRef(0);
  const [, setTick] = useState(0);
  const [input, setInput] = useState("");
  const [alive, setAlive] = useState(true);
  const [histCursor, setHistCursor] = useState(-1);
  const [restartKey, setRestartKey] = useState(0);
  // Tab-title bookkeeping (dedup so a chatty stream doesn't re-render the panel
  // per chunk): the command in flight + the last cwd we reported.
  const reportRef = useRef(report);
  reportRef.current = report;
  const runningRef = useRef<string | null>(null);
  const cwdSeenRef = useRef<string | null>(null);

  useEffect(() => {
    setAlive(true); // a (re)created session always starts alive
    buf.clear();

    // A resting prompt on the LAST line = the foreground command is done (and
    // cmd/PS prompts carry the cwd for the tab tooltip). Cheap per-chunk check.
    const promptCheck = (): void => {
      const p = parsePromptLine(buf.lastLineText());
      if (!p) return;
      if (runningRef.current !== null) {
        runningRef.current = null;
        reportRef.current({ running: null, ...(p.cwd ? { cwd: p.cwd } : null) });
      } else if (p.cwd && p.cwd !== cwdSeenRef.current) {
        cwdSeenRef.current = p.cwd;
        reportRef.current({ cwd: p.cwd });
      }
    };

    // Coalesce bursts of stdout into ~30fps paints. A TIMER, not rAF: rAF is
    // frozen while the window is hidden/minimised, so output would silently
    // stop rendering until the next focus (timers merely throttle).
    const refresh = (): void => {
      if (rafRef.current) return;
      rafRef.current = window.setTimeout(() => {
        rafRef.current = 0;
        setTick((t) => t + 1);
      }, 33);
    };

    const offData = window.wello.onTerminalData((e) => {
      if (e.id === idRef.current) {
        buf.write(e.data);
        promptCheck();
        // A hidden tab only buffers; its repaint catches up when it's shown.
        if (visibleRef.current) refresh();
      }
    });
    const offExit = window.wello.onTerminalExit((e) => {
      if (e.id === idRef.current) {
        // Our own out-of-band note: drop any dangling half-escape first so the
        // banner can't be glued onto it and garbled.
        buf.flushCarry();
        buf.write("\r\n\x1b[2m[сессия завершена]\x1b[0m\r\n");
        idRef.current = null;
        setAlive(false);
        runningRef.current = null;
        // A non-zero shell exit lights the tab's error dot (until it's visited).
        reportRef.current({ running: null, exit: e.code ?? 0 });
        if (visibleRef.current) refresh();
      }
    });
    let disposed = false;
    void window.wello.createTerminal(cwd).then((res) => {
      if (!res) {
        if (!disposed) {
          buf.write("Не удалось открыть терминал.\r\n");
          refresh();
        }
        return;
      }
      // The effect can be torn down before this resolves (StrictMode's probe
      // mount, or the user closing the tab instantly) — kill the orphan shell
      // right away instead of leaking it.
      if (disposed) {
        void window.wello.killTerminal(res.id);
      } else {
        idRef.current = res.id;
        // A fresh shell: title falls back to the shell's name, error dot clears.
        reportRef.current({ shell: res.shell, running: null, exit: null });
      }
    });

    return () => {
      disposed = true;
      if (rafRef.current) window.clearTimeout(rafRef.current);
      rafRef.current = 0;
      offData();
      offExit();
      const id = idRef.current;
      idRef.current = null;
      if (id) void window.wello.killTerminal(id);
    };
    // buf is a stable ref-backed instance for the session's lifetime.
  }, [cwd, restartKey]);

  // Follow the tail unless the user scrolled up to read something.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  });

  /** Clear the on-screen buffer (keeps the shell session + cwd). */
  const clearOutput = (): void => {
    buf.clear();
    setTick((t) => t + 1);
  };

  /** Copy the current selection, or the whole buffer when nothing is selected. */
  const copyOutput = (): void => {
    const sel = window.getSelection()?.toString();
    const text = sel && sel.trim() ? sel : buf.text();
    if (!text.trim()) {
      toast({ message: "Терминал пуст" });
      return;
    }
    void window.wello.copyText(text).then(
      () => toast({ message: "Вывод терминала скопирован", tone: "success" }),
      () => toast({ message: "Не удалось скопировать", tone: "danger" }),
    );
  };

  // The active tab owns the panel toolbar's copy/clear, catches up on anything
  // buffered while hidden, and takes the keyboard — but never steals focus from
  // a text field elsewhere (e.g. the composer, when a chat switch remounts us).
  useEffect(() => {
    if (!visible) return;
    register({ copy: copyOutput, clear: clearOutput });
    setTick((t) => t + 1);
    const ae = document.activeElement;
    if (!ae || ae === document.body || (ae instanceof HTMLElement && ae.closest(".terminal"))) {
      inputRef.current?.focus();
    }
  }, [visible]);

  const send = (): void => {
    const id = idRef.current;
    if (!id) return;
    void window.wello.writeTerminal(id, `${input}\n`);
    const trimmed = input.trim();
    if (trimmed) {
      historyRef.current = [...historyRef.current.slice(-100), input];
      // The command's first word becomes the tab title until the prompt returns
      // (the closest honest stand-in for "foreground process" over a piped shell).
      const word = trimmed.split(/\s+/)[0] ?? "";
      if (word) {
        runningRef.current = word;
        reportRef.current({ running: word });
      }
    }
    setHistCursor(-1);
    setInput("");
    atBottomRef.current = true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const hist = historyRef.current;
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (hist.length === 0) return;
      const next = histCursor < 0 ? hist.length - 1 : Math.max(0, histCursor - 1);
      setHistCursor(next);
      setInput(hist[next] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histCursor < 0) return;
      const next = histCursor + 1;
      if (next >= hist.length) {
        setHistCursor(-1);
        setInput("");
      } else {
        setHistCursor(next);
        setInput(hist[next] ?? "");
      }
    } else if (e.key === "c" && e.ctrlKey && !window.getSelection()?.toString()) {
      // Best-effort interrupt (a piped shell may ignore it — Close kills the tree).
      const id = idRef.current;
      if (id) void window.wello.writeTerminal(id, "\x03");
    } else if (e.key === "l" && e.ctrlKey) {
      // Terminal convention: Ctrl+L clears the screen.
      e.preventDefault();
      clearOutput();
    }
  };

  const lines = buf.spans();

  return (
    <div className={`terminal__session ${visible ? "" : "is-hidden"}`}>
      <div
        className="termout"
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (el) atBottomRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
        onMouseUp={() => {
          // Click-through focus, but never steal an in-progress text selection.
          if (!window.getSelection()?.toString()) inputRef.current?.focus();
        }}
      >
        {/* Keys are GLOBAL line indices: when the scrollback trims from the front,
            surviving lines keep their key (and their memoised DOM). */}
        {lines.map((spans, i) => (
          <TermLine key={buf.firstLineIndex + i} spans={spans} />
        ))}
        {alive ? <span className="termout__cursor" aria-hidden /> : null}
      </div>
      <div className="terminal__input">
        {alive ? (
          <>
            <span className="terminal__prompt" aria-hidden>
              ›
            </span>
            <input
              ref={inputRef}
              className="terminal__field"
              value={input}
              placeholder="Введите команду…"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </>
        ) : (
          <>
            <span className="terminal__field terminal__ended">Сессия завершена</span>
            <button className="button ghost sm" onClick={() => setRestartKey((k) => k + 1)}>
              <Icon name="undo" size={13} />
              Перезапустить
            </button>
          </>
        )}
      </div>
    </div>
  );
}
