import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DevScriptInfo,
  DevServerState,
  PreviewBounds,
  PreviewViewNavState,
  WorkspaceFile,
} from "../../shared/ipc-api";
import type { SubagentInfo } from "./agent-state";
import { highlight, languageForPath } from "./highlight";
import { Icon, type IconName } from "./Icon";
import { Markdown } from "./Markdown";
import {
  DEVICE_PRESETS,
  PREVIEW_DEVICE_LS_KEY,
  resolveAddressInput,
  type DevicePreset,
} from "./preview-device";
import { toast } from "./Toaster";

// The tabbed Inspector wrapper is gone: the content panes below now live as
// stacked cards inside the PanelStack (Panels.tsx), Claude Code style.

/* -------------------------------- Preview -------------------------------- */

/** The centered device rectangle inside the pane: desktop fills it; phone /
 *  tablet get their true CSS width (scaled down by main when the pane is
 *  narrower — breakpoints still fire at the real width). */
function deviceRect(host: DOMRect, device: DevicePreset["id"]): PreviewBounds {
  const preset = DEVICE_PRESETS.find((d) => d.id === device) ?? DEVICE_PRESETS[2]!;
  if (preset.width === "fill") {
    return { x: host.left, y: host.top, width: host.width, height: host.height };
  }
  const pad = 12;
  const w = Math.min(Math.max(60, host.width - pad * 2), preset.width);
  return {
    x: host.left + (host.width - w) / 2,
    y: host.top + pad,
    width: w,
    height: Math.max(60, host.height - pad * 2),
  };
}

/**
 * Live preview — a real embedded browser (WebContentsView in main, laid over
 * this pane's rectangle): an address bar that loads URLs or Googles anything
 * else, native back/forward/links (any site — X-Frame-Options doesn't apply),
 * the workspace's dev servers listed on the empty screen with one-click start,
 * or the loopback static server as the zero-config default. The page runs in
 * its own sandboxed session — its JS can never reach window.wello. A device
 * switcher lays the page out at true CSS width via device emulation; a file
 * change reloads the static preview (dev servers HMR themselves).
 */
export function PreviewPane({
  workspacePath,
  active,
  onCapture,
}: {
  workspacePath: string;
  active: boolean;
  onCapture: (path: string) => void;
}) {
  const [staticUrl, setStaticUrl] = useState<string | null>(null);
  const [staticErr, setStaticErr] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [dev, setDev] = useState<DevServerState | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [scripts, setScripts] = useState<DevScriptInfo[]>([]);
  // Manual navigation: the address the user loaded (null = follow dev/static).
  // History/back/forward are NATIVE now — main streams the nav state up.
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [addr, setAddr] = useState("");
  const [nav, setNav] = useState<PreviewViewNavState | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const addrRef = useRef<HTMLInputElement>(null);
  const [overlays, setOverlays] = useState(0);
  const [device, setDevice] = useState<DevicePreset["id"]>(() => {
    const saved = localStorage.getItem(PREVIEW_DEVICE_LS_KEY);
    return saved === "mobile" || saved === "tablet" ? saved : "desktop";
  });

  // Static loopback preview of the built output.
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void window.wello.startPreview(workspacePath).then((r) => {
      if (!alive) return;
      if ("url" in r) {
        setStaticUrl(r.url);
        setStaticErr(null);
      } else {
        setStaticUrl(null);
        setStaticErr(r.error);
      }
    });
    const off = window.wello.onPreviewChange(() => setReloadKey((k) => k + 1));
    return () => {
      alive = false;
      off();
      void window.wello.stopPreview();
    };
  }, [workspacePath, active]);

  // Dev-server detection + live state.
  useEffect(() => {
    if (!active) return;
    void window.wello.detectDevScripts(workspacePath).then(setScripts);
    void window.wello.getDevServer(workspacePath).then(setDev);
    const off = window.wello.onDevServerEvent((e) => {
      if (e.workspacePath !== workspacePath) return;
      setDev(e);
      // Accumulate streamed output (capped) so a slow first build or a crash is
      // visible right here, not a black box (the log lines already reach us).
      if (e.logLine) setLogs((prev) => [...prev.slice(-199), e.logLine!]);
    });
    return () => off();
  }, [workspacePath, active]);

  const startDev = useCallback(
    (s: DevScriptInfo) => {
      setLogs([]);
      void window.wello
        .startDevServer({ workspacePath, script: s.script, defaultPort: s.defaultPort })
        .then(setDev);
    },
    [workspacePath],
  );
  const stopDev = useCallback(() => {
    if (dev?.id) void window.wello.stopDevServer(dev.id);
  }, [dev]);

  const pickDevice = (id: DevicePreset["id"]): void => {
    setDevice(id);
    localStorage.setItem(PREVIEW_DEVICE_LS_KEY, id);
  };

  const devUrl = dev?.status === "listening" ? dev.url : undefined;
  const url = manualUrl ?? devUrl ?? staticUrl ?? undefined;
  const recommended = scripts.find((s) => s.recommended) ?? scripts[0];

  // The address bar mirrors what's actually loaded: the live nav state (link
  // clicks, redirects) when it flows, the requested url before that — but never
  // while the user is typing in the field.
  useEffect(() => {
    setAddr(url ?? "");
  }, [url]);
  useEffect(() => window.wello.onPreviewViewState(setNav), []);
  useEffect(() => {
    if (nav?.url && document.activeElement !== addrRef.current) setAddr(nav.url);
  }, [nav]);

  // Overlays (modals / palette / lightbox) paint UNDER a native view — hide the
  // browser surface while any is open so dialogs are never covered by the page.
  useEffect(() => {
    const open = (): void => setOverlays((n) => n + 1);
    const close = (): void => setOverlays((n) => Math.max(0, n - 1));
    window.addEventListener("wello-overlay-open", open);
    window.addEventListener("wello-overlay-close", close);
    return () => {
      window.removeEventListener("wello-overlay-open", open);
      window.removeEventListener("wello-overlay-close", close);
    };
  }, []);

  // Geometry + url sync: the native view tracks the pane's rectangle (resize
  // observer for size, a slow poll for pure position shifts, 0-size = hidden —
  // that's the settings mode, which hides the dock without unmounting it).
  useEffect(() => {
    const el = hostRef.current;
    if (!url || !el || overlays > 0) {
      void window.wello.previewViewHide();
      return;
    }
    let last = "";
    const push = (): void => {
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) {
        if (last !== "hidden") {
          last = "hidden";
          void window.wello.previewViewHide();
        }
        return;
      }
      const b = deviceRect(r, device);
      const key = [
        Math.round(b.x),
        Math.round(b.y),
        Math.round(b.width),
        Math.round(b.height),
        url,
        device,
      ].join("|");
      if (key === last) return;
      last = key;
      void window.wello.previewViewShow(b, url, device);
    };
    push();
    const ro = new ResizeObserver(push);
    ro.observe(el);
    window.addEventListener("resize", push);
    const iv = window.setInterval(push, 300);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", push);
      window.clearInterval(iv);
    };
  }, [url, device, overlays]);

  // Pane closed → free the browser surface entirely.
  useEffect(() => () => void window.wello.previewViewDestroy(), []);

  // A watched file changed → reload the static preview (dev servers HMR).
  const lastReloadRef = useRef(0);
  useEffect(() => {
    if (reloadKey !== lastReloadRef.current) {
      lastReloadRef.current = reloadKey;
      if (url) void window.wello.previewViewReload();
    }
  }, [reloadKey, url]);

  /** Omnibox: load a URL, Google anything else; Enter on the current page reloads. */
  const submitAddress = (): void => {
    const target = resolveAddressInput(addr);
    if (!target) return;
    if (target === url) {
      void window.wello.previewViewReload();
      return;
    }
    setManualUrl(target);
  };

  const captureShot = async (): Promise<void> => {
    const path = await window.wello.previewViewCapture();
    if (path) onCapture(path);
  };
  return (
    <div className="preview">
      <div className="preview__bar">
        <button
          className="icon-button"
          title="Назад"
          aria-label="Назад"
          disabled={!nav?.canGoBack}
          onClick={() => void window.wello.previewViewBack()}
        >
          <Icon name="back" size={13} />
        </button>
        <button
          className="icon-button"
          title="Вперёд"
          aria-label="Вперёд"
          disabled={!nav?.canGoForward}
          onClick={() => void window.wello.previewViewForward()}
        >
          <Icon name="forward" size={13} />
        </button>
        <button
          className="icon-button"
          title="Обновить превью"
          aria-label="Обновить превью"
          onClick={() => void window.wello.previewViewReload()}
        >
          <Icon name="undo" size={13} />
        </button>
        <input
          ref={addrRef}
          className="preview__addr"
          placeholder="URL или поиск в Google"
          value={addr}
          spellCheck={false}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              submitAddress();
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setAddr(nav?.url ?? url ?? "");
              (e.target as HTMLInputElement).blur();
            }
          }}
          onFocus={(e) => e.target.select()}
        />
        {nav?.loading && url ? <span className="spinner preview__spin" /> : null}
        <div className="segment segment--sm" role="group" aria-label="Устройство">
          {DEVICE_PRESETS.map((d) => (
            <button
              key={d.id}
              className="segment-button"
              aria-pressed={device === d.id}
              onClick={() => pickDevice(d.id)}
            >
              {d.label}
            </button>
          ))}
        </div>
        {url ? (
          <button
            className="icon-button"
            title="Скриншот агенту"
            aria-label="Отправить скриншот превью агенту"
            onClick={() => void captureShot()}
          >
            <Icon name="image" size={13} />
          </button>
        ) : null}
        {url ? (
          <button
            className="icon-button"
            title="Открыть в браузере"
            aria-label="Открыть в браузере"
            onClick={() => void window.wello.openExternal(url)}
          >
            <Icon name="external" size={13} />
          </button>
        ) : null}
      </div>
      {/* The control strip shows for a LIVE server (stop/restart) or as the
          "detected, start it" nudge over the static preview; the empty screen
          below owns discovery when nothing is loaded at all. */}
      {recommended && (dev || url) ? (
        <DevServerBar
          dev={dev}
          recommended={recommended}
          lastLog={logs[logs.length - 1]}
          onStart={startDev}
          onStop={stopDev}
        />
      ) : null}
      <DevConsole logs={logs} onClear={() => setLogs([])} />
      {url ? (
        // The native browser surface renders OVER this host rect (main-side
        // WebContentsView) — the div only reserves and reports the geometry.
        <div className="pvhost" ref={hostRef} aria-label="Превью" />
      ) : scripts.length > 0 ? (
        // Claude Code's empty screen: the workspace's dev servers, one-click start.
        <div className="pvstart">
          <div className="pvstart__list" role="list">
            {scripts.map((s) => (
              <div key={s.script} className="pvstart__row" role="listitem">
                <Icon name="terminal" size={13} />
                <span className="pvstart__name">{s.script}</span>
                {s.framework ? <span className="pvstart__fw">{s.framework}</span> : null}
                <span className="pvstart__port">:{s.defaultPort}</span>
                <button
                  className="icon-button pvstart__go"
                  title={`Запустить ${s.script}`}
                  aria-label={`Запустить dev-сервер ${s.script}`}
                  onClick={() => startDev(s)}
                >
                  <Icon name="forward" size={12} />
                </button>
              </div>
            ))}
          </div>
          <p className="pvstart__hint">…или введите URL в адресной строке сверху.</p>
        </div>
      ) : staticErr === "no_index" ? (
        <p className="muted inspector__note">
          Не найден index.html (в корне или в dist / build / out / public). Соберите проект, добавьте
          index.html — или введите URL в адресной строке.
        </p>
      ) : staticErr ? (
        <p className="muted inspector__note">Не удалось запустить превью.</p>
      ) : (
        <p className="muted inspector__note">Запуск превью…</p>
      )}
    </div>
  );
}

/** Dev-server control strip: detect → start → live URL / crash, all consent-gated. */
function DevServerBar({
  dev,
  recommended,
  lastLog,
  onStart,
  onStop,
}: {
  dev: DevServerState | null;
  recommended: DevScriptInfo;
  lastLog?: string;
  onStart: (s: DevScriptInfo) => void;
  onStop: () => void;
}) {
  if (dev?.status === "starting") {
    return (
      <div className="devbar">
        <span className="spinner" />
        <span>Запуск dev-сервера…</span>
        <span className="inspector__spacer" />
        <button className="button ghost sm" onClick={onStop}>
          Стоп
        </button>
      </div>
    );
  }
  if (dev?.status === "listening") {
    return (
      <div className="devbar devbar--ok">
        <Icon name="globe" size={12} />
        <span className="devbar__url" title={dev.url}>
          {dev.url?.replace(/^https?:\/\//, "").replace(/\/$/, "")}
        </span>
        <span className="inspector__spacer" />
        <button className="button ghost sm" onClick={onStop}>
          Стоп
        </button>
      </div>
    );
  }
  const crashed = dev?.status === "crashed";
  const crashText =
    dev?.exitCode != null && dev.exitCode !== 0
      ? `Dev-сервер остановился (код ${dev.exitCode}).`
      : "Dev-сервер остановился.";
  return (
    <div className={`devbar ${crashed ? "devbar--warn" : ""}`}>
      <Icon name="rocket" size={12} />
      <div className="devbar__msg">
        <span>
          {crashed
            ? crashText
            : `Обнаружен dev-сервер${recommended.framework ? ` (${recommended.framework})` : ""}.`}
        </span>
        {crashed && lastLog ? <span className="devbar__reason">{lastLog}</span> : null}
      </div>
      <span className="inspector__spacer" />
      <button className="button primary sm" onClick={() => onStart(recommended)}>
        {crashed ? "Перезапустить" : "Запустить"}
      </button>
    </div>
  );
}

/** Streamed dev-server output — the nearest thing to Claude Code's command log. */
function DevConsole({ logs, onClear }: { logs: string[]; onClear: () => void }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);
  if (logs.length === 0) return null;
  return (
    <div className="devconsole">
      <div className="devconsole__bar">
        <Icon name="terminal" size={12} />
        <span className="devconsole__title">Вывод dev-сервера</span>
        <span className="inspector__spacer" />
        <button
          className="icon-button"
          title="Копировать вывод"
          aria-label="Копировать вывод dev-сервера"
          onClick={() =>
            void window.wello.copyText(logs.join("\n")).then(
              () => toast({ message: "Вывод скопирован", tone: "success" }),
              () => toast({ message: "Не удалось скопировать", tone: "danger" }),
            )
          }
        >
          <Icon name="copy" size={12} />
        </button>
        <button
          className="icon-button"
          title="Очистить"
          aria-label="Очистить вывод"
          onClick={onClear}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
      <pre className="devconsole__out" ref={ref}>
        {logs.join("\n")}
      </pre>
    </div>
  );
}

/* ------------------------------- File view ------------------------------- */

export function FilePane({ workspacePath, path }: { workspacePath: string; path: string }) {
  const [file, setFile] = useState<WorkspaceFile | null>(null);
  const isMarkdown = /\.(md|markdown)$/i.test(path);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    setFile(null);
    setShowSource(false);
    void window.wello.readWorkspaceFile(workspacePath, path).then(setFile);
  }, [workspacePath, path]);

  const segments = path.split("/");
  return (
    <div className="filepane">
      <div className="filepane__bar">
        <span className="filepane__crumbs" title={path}>
          {segments.map((seg, i) => (
            <span key={i} className={i === segments.length - 1 ? "filepane__leaf" : "filepane__seg"}>
              {seg}
              {i < segments.length - 1 ? <span className="filepane__sep">›</span> : null}
            </span>
          ))}
        </span>
        <span className="inspector__spacer" />
        {isMarkdown && file?.ok ? (
          <button
            className={`button ghost sm ${showSource ? "" : ""}`}
            onClick={() => setShowSource((v) => !v)}
          >
            {showSource ? "Просмотр" : "Исходный текст"}
          </button>
        ) : null}
        <button
          className="icon-button"
          title="Открыть в системном редакторе"
          aria-label="Открыть в системном редакторе"
          onClick={() => void window.wello.openWorkspaceFile(workspacePath, path)}
        >
          <Icon name="external" size={13} />
        </button>
      </div>
      {!file ? null : !file.ok ? (
        <p className="muted inspector__note">
          {file.reason === "too_large"
            ? "Файл слишком большой для просмотра."
            : file.reason === "binary"
              ? "Бинарный файл — просмотр недоступен."
              : "Файл не найден."}
        </p>
      ) : isMarkdown && !showSource ? (
        <div className="filepane__md">
          <Markdown text={file.content} />
        </div>
      ) : (
        <CodeView content={file.content} path={path} />
      )}
    </div>
  );
}

function CodeView({ content, path }: { content: string; path: string }) {
  const rows = useMemo(() => {
    const lang = languageForPath(path);
    return content
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => ({ line, html: highlight(line, lang) }));
  }, [content, path]);
  return (
    <pre className="diff" aria-label="Содержимое файла">
      {rows.map((row, i) => (
        <div key={i} className="dl dl--ctx">
          <span className="dl__num">{i + 1}</span>
          {row.html != null ? (
            <span className="dl__text is-code" dangerouslySetInnerHTML={{ __html: row.html || " " }} />
          ) : (
            <span className="dl__text">{row.line || " "}</span>
          )}
        </div>
      ))}
    </pre>
  );
}

/* ----------------------------- Subagents panel ---------------------------- */

// Colour encodes STATUS (running / done / failed); the GLYPH distinguishes one
// agent from another so a roster is scannable at a glance. The glyph is
// THEMATIC — matched from the
// agent's title keywords (design → pen, audit → shield, search → lens …), with
// a stable id-hash fallback; the avatar colour is a stable id-hash pick from a
// warm 8-hue palette. Status never repaints the avatar — it rides as a corner
// badge / pulse ring, so «who» (colour+glyph) and «how» (accent) read apart.
const ROLE_ICONS: IconName[] = [
  "search",
  "wrench",
  "shieldcheck",
  "rocket",
  "bug",
  "compose",
  "globe",
  "subagent",
];

/** Keyword → glyph, RU + EN (labels come from model-authored agent titles). */
const THEME_ICONS: [RegExp, IconName][] = [
  [/дизайн|design|ui|palette|стил|colou?r|copy|текст|верст/i, "compose"],
  [/аудит|audit|ревью|review|preflight|security|безопас|провер|verify/i, "shieldcheck"],
  [/поиск|search|research|исслед|find|скан|explore|analy[sz]|анализ/i, "search"],
  [/тест|test|баг|bug|repro|flak/i, "bug"],
  [/фикс|fix|почин|patch|refactor|рефактор/i, "wrench"],
  [/деплой|deploy|push|release|релиз|publish|ship/i, "rocket"],
  [/веб|web|сайт|fetch|http|интернет|url/i, "globe"],
  [/док|docs?|readme|описан|write|стать/i, "file"],
  [/картин|image|фото|icon|logo|лого/i, "image"],
  [/терминал|terminal|команд|command|script|скрипт|запуск|run/i, "terminal"],
];

/** 8 stable avatar hues (600-weight — legible as glyph AND as a 16% tint). */
const AGENT_HUES = [
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f59e0b",
  "#f97316",
  "#22c55e",
  "#6366f1",
];

function hashOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** The agent's visual identity: thematic glyph + a stable colour. */
export function agentTheme(agent: { id: string; title: string }): { icon: IconName; hue: string } {
  const themed = THEME_ICONS.find(([re]) => re.test(agent.title))?.[1];
  const h = hashOf(agent.id);
  return {
    icon: themed ?? ROLE_ICONS[h % ROLE_ICONS.length]!,
    hue: AGENT_HUES[h % AGENT_HUES.length]!,
  };
}

/** The tinted avatar chip + its status accent (corner badge / pulse ring). */
function AgentAvatar({ agent }: { agent: SubagentInfo }) {
  const { icon, hue } = agentTheme(agent);
  return (
    <span
      className={`agents__avatar ${agent.status === "running" ? "is-running" : ""}`}
      style={{ "--ag": hue } as React.CSSProperties}
      aria-hidden
    >
      <Icon name={icon} size={13} />
      {agent.status === "done" ? (
        <span className="agents__avatar-badge agents__avatar-badge--done">
          <Icon name="check" size={8} />
        </span>
      ) : agent.status === "failed" ? (
        <span className="agents__avatar-badge agents__avatar-badge--failed">
          <Icon name="x" size={7} />
        </span>
      ) : null}
    </span>
  );
}

/** Compact RU duration for the roster ("5с" / "14м" / "1ч 3м"). */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}м`;
  return `${Math.floor(m / 60)}ч ${m % 60}м`;
}

/** How long an agent ran (done/failed) or has been running so far (live). */
function agentTiming(agent: SubagentInfo, now: number): string {
  const start = Date.parse(agent.startedAt);
  const end = agent.finishedAt ? Date.parse(agent.finishedAt) : now;
  return fmtElapsed(end - start);
}

export function AgentsPanel({ subagents }: { subagents: SubagentInfo[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = subagents.find((s) => s.id === selectedId) ?? null;

  // Live tick for the running agents' timers — only while something is running,
  // so an idle roster costs nothing.
  const hasRunning = subagents.some((s) => s.status === "running");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasRunning]);

  // Follow a running subagent's growing transcript to the bottom.
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el && selected?.status === "running") el.scrollTop = el.scrollHeight;
  }, [selected?.transcript.length, selected?.status]);

  if (selected) {
    const copyTranscript = (): void => {
      const md = selected.transcript
        .map((t) => (t.entry === "tool" ? `- ${t.text}` : t.text))
        .join("\n\n");
      void window.wello.copyText(md).then(
        () => toast({ message: "Транскрипт скопирован", tone: "success" }),
        () => toast({ message: "Не удалось скопировать", tone: "danger" }),
      );
    };
    return (
      <div className="agents">
        <div className="agents__bar">
          <button
            className="icon-button"
            title="Назад к списку"
            aria-label="Назад к списку"
            onClick={() => setSelectedId(null)}
          >
            <Icon name="back" size={14} />
          </button>
          <AgentAvatar agent={selected} />
          <span className="agents__name">{selected.title}</span>
          <span className={`agents__meta agents__meta--${selected.status}`}>
            {selected.status === "running"
              ? `выполняется · ${agentTiming(selected, now)}`
              : selected.status === "failed"
                ? `ошибка · ${agentTiming(selected, now)}`
                : agentTiming(selected, now)}
          </span>
          <span className="inspector__spacer" />
          <button
            className="icon-button"
            title="Копировать транскрипт"
            aria-label="Копировать транскрипт субагента"
            disabled={selected.transcript.length === 0}
            onClick={copyTranscript}
          >
            <Icon name="copy" size={13} />
          </button>
        </div>
        <div className="agents__transcript" ref={transcriptRef}>
          {selected.transcript.length === 0 ? (
            <p className="muted inspector__note">Пока нет вывода.</p>
          ) : (
            selected.transcript.map((t, i) =>
              t.entry === "tool" ? (
                <div key={i} className="agents__tool">
                  <Icon name="terminal" size={12} />
                  <span>{t.text}</span>
                </div>
              ) : (
                <div key={i} className="agents__text">
                  <Markdown text={t.text} />
                </div>
              ),
            )
          )}
          {selected.status === "running" ? (
            <div className="agents__tool">
              <span className="spinner" />
              <span className="muted">Работает…</span>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  const running = subagents.filter((s) => s.status === "running");
  const finished = subagents.filter((s) => s.status !== "running");
  return (
    <div className="agents">
      {subagents.length === 0 ? (
        <p className="muted inspector__note">
          Здесь появятся субагенты, когда агент запустит параллельные задачи.
        </p>
      ) : (
        <div className="agents__list">
          {running.length > 0 ? (
            <p className="agents__section">
              <span className="agents__pulse" aria-hidden />
              Активные · {running.length}
            </p>
          ) : null}
          {running.map((s) => (
            <AgentRow key={s.id} agent={s} now={now} onOpen={() => setSelectedId(s.id)} />
          ))}
          {finished.length > 0 ? <p className="agents__section">Готово · {finished.length}</p> : null}
          {finished.map((s) => (
            <AgentRow key={s.id} agent={s} now={now} onOpen={() => setSelectedId(s.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentRow({ agent, now, onOpen }: { agent: SubagentInfo; now: number; onOpen: () => void }) {
  const lastText = [...agent.transcript].reverse().find((t) => t.entry === "text")?.text ?? "";
  const preview =
    agent.status === "running"
      ? "Выполнение…"
      : agent.status === "failed"
        ? lastText || "Не удалось завершить"
        : lastText || "Готово";
  return (
    <button className="agents__row" onClick={onOpen}>
      <AgentAvatar agent={agent} />
      <span className="agents__body">
        <span className="agents__name">{agent.title}</span>
        <span className="agents__preview">{preview}</span>
      </span>
      <span
        className={`agents__meta agents__meta--${agent.status}`}
        title={agent.status === "running" ? "Выполняется" : agent.status === "failed" ? "Ошибка" : "Завершено"}
      >
        {agentTiming(agent, now)}
      </span>
    </button>
  );
}
