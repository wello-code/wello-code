import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal, flushSync } from "react-dom";
import type {
  PermissionDecision,
  PermissionRequest,
  PlanTodo,
  QuestionAnswer,
  QuestionReply,
  QuestionRequest,
  TaskMode,
} from "@wello-code/contracts";
import type {
  ChangeSummary,
  Connection,
  GitBranchInfo,
  GitConflictInfo,
  GitSyncInfo,
  StartRunInput,
  WorkspaceInfo,
  WorkspaceTrust,
} from "../../shared/ipc-api";
import {
  collectPromptHistory,
  historyDown,
  historyUp,
  type HistoryNav,
} from "./prompt-history";
import { BranchPopover } from "./BranchPopover";
import { GithubConnectCard } from "./GitHubConnect";
import { chatToMarkdown, transcriptForHandoff } from "./transcript";
import { Modal, ModalCancel } from "./Modal";
import type { TimelineItem, UserAttachment } from "./agent-state";
import { describeCurrentAction, toolActionLabel } from "./agent-state";
import {
  groupTasks,
  initialTasksState,
  tasksReducer,
  titleFromPrompt,
  type TaskItem,
} from "./tasks-state";
import { admitAttachments, limitNotice } from "./attachments";
import { detectMention, rankFileMentions, type MentionQuery } from "./file-mention";
import { matchHotkey } from "./hotkeys";
import { mergeQueued } from "./queued";
import { detectSlash, rankSlashCommands, type SlashQuery } from "./slash-command";
import { commandArgString, expandCommandTemplate } from "../../shared/slash-template";
import { AttachThumb, ChatImages, Lightbox } from "./Images";
import { Icon, type IconName } from "./Icon";
import { loadDockPrefs, restorablePanels, saveDockPrefs } from "./dock-layout";
import { DOCK_MIN, PanelDock, type PanelId } from "./Panels";
import { Markdown } from "./Markdown";
import { SettingsView } from "./Settings";
import {
  loadLastSettingsPage,
  saveLastSettingsPage,
  type SettingsPageId,
} from "./settings-nav";
import { Toaster, toast } from "./Toaster";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";

type Screen = "loading" | "connect" | "workspace";
type ToolItem = Extract<TimelineItem, { kind: "tool" }>;

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Composer attachments: picked files/folders, images or a large clipboard paste. */
type Attachment =
  | { kind: "file"; id: string; path: string }
  | { kind: "folder"; id: string; path: string }
  | { kind: "image"; id: string; path: string; preview?: string }
  | { kind: "paste"; id: string; label: string; text: string };

function baseName(p: string): string {
  const clean = p.replace(/[\\/]+$/, "");
  const idx = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return idx === -1 ? clean : clean.slice(idx + 1);
}

/** The model-facing prompt: user text + file paths + inlined pastes. */
function buildPrompt(text: string, atts: Attachment[]): string {
  if (atts.length === 0) return text;
  const parts: string[] = text ? [text] : [];
  const paths = atts.filter((a) => a.kind === "file" || a.kind === "folder");
  if (paths.length > 0) {
    parts.push(
      "Прикреплённые файлы и папки (изучи их содержимое, когда потребуется):\n" +
        paths.map((a) => `- ${a.path}${a.kind === "folder" ? " (папка)" : ""}`).join("\n"),
    );
  }
  const images = atts.filter((a) => a.kind === "image");
  if (images.length > 0) {
    parts.push(
      "Прикреплённые изображения (открой каждое инструментом Read, чтобы увидеть):\n" +
        images.map((a) => `- ${a.path}`).join("\n"),
    );
  }
  for (const a of atts) {
    if (a.kind === "paste") {
      parts.push(`<pasted-content name="${a.label}">\n${a.text}\n</pasted-content>`);
    }
  }
  return parts.join("\n\n");
}

/** What an attachment chip / the user bubble calls this attachment. */
function attachmentLabel(a: Attachment): string {
  if (a.kind === "paste") return a.label;
  if (a.kind === "image") return "Изображение";
  return baseName(a.path);
}

/**
 * Non-image attachments as chips on the sent message (images render as real
 * previews) — nothing is appended to the bubble text anymore.
 */
function attachmentMeta(atts: Attachment[]): UserAttachment[] {
  return atts.flatMap((a) =>
    a.kind === "image" ? [] : [{ kind: a.kind, label: attachmentLabel(a) }],
  );
}

/** What the user "said" for the timeline: bubble text + chips + previews + retry payload. */
interface TurnContent {
  shown?: string;
  images?: string[];
  attachments?: UserAttachment[];
}

/** A message typed while a run was in flight, held until that task's run ends.
 *  Several may stack per task (Claude Code style) — they flush FIFO, one per
 *  finished run, and render as muted bubbles at the tail of the thread. */
interface QueuedMessage {
  id: string;
  taskId: string;
  fullText: string;
  content: TurnContent;
  /** Short text shown on the queued bubble. */
  preview: string;
}

const PASTE_CHARS = 1500;
const PASTE_LINES = 15;
const IMAGE_FILE_RE = /\.(png|jpe?g|webp|gif)$/i;

/** Data URL for the chip thumbnail (CSP allows img-src data:, not blob:). */
function blobToDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/** Draft-map key for a chat (or the home/new-chat composer when there's no task). */
function draftKey(id: string | null): string {
  return id ?? "__home__";
}

/** Russian plural form: (1, "файл", "файла", "файлов"). */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * The whole boot state is ONE quiet spinner on the app background (no card, no
 * logo, no text) — the overlay shares the app's canvas so the hand-off into the
 * UI is seamless. When the app is ready the arc completes into a full ring
 * (~200ms) and the overlay fades out (~180ms); a near-instant boot (<150ms)
 * skips the ceremony and just vanishes (anti-flicker). Reduced motion swaps the
 * rotation for a soft opacity pulse and finishes with a plain fade.
 */
function BootOverlay({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [phase, setPhase] = useState<"spin" | "finish" | "fade">("spin");
  const bornAt = useRef(performance.now());
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (!ready) return;
    if (performance.now() - bornAt.current < 150) {
      doneRef.current();
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPhase("fade");
      const t = window.setTimeout(() => doneRef.current(), 200);
      return () => window.clearTimeout(t);
    }
    setPhase("finish");
    const t1 = window.setTimeout(() => setPhase("fade"), 200);
    const t2 = window.setTimeout(() => doneRef.current(), 380);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [ready]);

  return (
    <div
      className={`boot ${phase === "spin" ? "" : `is-${phase}`}`}
      role="status"
      aria-label="Загрузка Wello Code"
    >
      <svg className="boot__ring" width="36" height="36" viewBox="0 0 40 40" aria-hidden>
        <circle className="boot__arc" cx="20" cy="20" r="17" fill="none" strokeWidth="2.5" />
      </svg>
    </div>
  );
}

export function App() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [screen, setScreen] = useState<Screen>("loading");
  // The boot overlay unmounts itself after its exit animation (or instantly).
  const [booting, setBooting] = useState(true);

  useEffect(() => {
    void window.wello.getConnection().then((c) => {
      setConnection(c);
      setScreen(c.connected ? "workspace" : "connect");
    });
  }, []);

  let body: React.JSX.Element | null = null;
  if (screen === "connect") {
    body = (
      <Connect
        onConnected={(c) => {
          setConnection(c);
          setScreen("workspace");
        }}
      />
    );
  } else if (screen === "workspace") {
    body = (
      <Workspace
        connection={connection}
        onDisconnect={async () => {
          await window.wello.clearApiKey();
          setConnection(null);
          setScreen("connect");
        }}
      />
    );
  }
  return (
    <>
      {body}
      {booting ? (
        <BootOverlay ready={screen !== "loading"} onDone={() => setBooting(false)} />
      ) : null}
      <Toaster />
    </>
  );
}

function Connect({ onConnected }: { onConnected: (c: Connection) => void }) {
  // Primary flow: one button → the system browser → wello.dev confirms under the
  // site session (already signed in there = a single click) and hands the app its
  // own key. The legacy paste-a-key flow stays reachable behind a small link.
  const [via, setVia] = useState<"account" | "key">("account");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Wello keys look like «wlo_live_…»; a soft hint (not a hard block) catches the
  // common "pasted the wrong string / with a stray space" mistake before submit.
  const trimmedKey = key.trim();
  const keyLooksValid = trimmedKey === "" || trimmedKey.startsWith("wlo_");
  const canSubmit = trimmedKey.length > 0;

  const signInBrowser = async (): Promise<void> => {
    if (waiting) return;
    setWaiting(true);
    setError(null);
    try {
      const c = await window.wello.signInViaBrowser();
      setWaiting(false);
      if (c.connected) onConnected(c);
      // No error = the user cancelled the wait themselves; stay quiet.
      else if (c.error) setError(c.error);
    } catch {
      setWaiting(false);
      setError("Не удалось связаться с Wello. Проверьте интернет и попробуйте снова.");
    }
  };

  const cancelWait = (): void => {
    void window.wello.cancelBrowserSignIn();
  };

  const submitKey = async (): Promise<void> => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      const c = await window.wello.setApiKey(trimmedKey);
      setBusy(false);
      if (c.connected) onConnected(c);
      else setError(c.error ?? "Ключ не подошёл. Проверьте, что скопировали его целиком.");
    } catch {
      setBusy(false);
      setError("Не удалось связаться с Wello. Проверьте интернет и попробуйте снова.");
    }
  };

  const switchVia = (next: "account" | "key"): void => {
    if (waiting) cancelWait();
    setVia(next);
    setError(null);
    setShow(false);
  };

  return (
    <main className="center">
      <section className="card wello-rise" aria-labelledby="connect-title">
        <h1 id="connect-title" className="card__title">
          Wello Code
        </h1>
        {via === "account" ? (
          <>
            <p className="card__subtitle">
              Нажмите кнопку — откроется wello.dev. Если вы уже вошли на сайте, останется одно
              подтверждение.
            </p>
            {error ? <p className="field__error">{error}</p> : null}
            {waiting ? (
              <>
                <div className="loading-row" role="status">
                  <span className="spinner" aria-hidden />
                  <span className="loading-row__text">Ждём подтверждения в браузере…</span>
                </div>
                <button className="button secondary block" onClick={cancelWait}>
                  Отменить
                </button>
              </>
            ) : (
              <button className="button primary block" autoFocus onClick={() => void signInBrowser()}>
                Войти через браузер
              </button>
            )}
            <p className="card__hint">
              Нет аккаунта? Зарегистрируйтесь в открывшемся окне — вход продолжится автоматически.
            </p>
            <p className="card__hint">
              Приложение получает собственный ключ доступа и хранит его в системном хранилище
              учётных данных — пароль ему не нужен.{" "}
              <button type="button" className="card__link" onClick={() => switchVia("key")}>
                Войти по API-ключу
              </button>
            </p>
          </>
        ) : (
          <>
            <p className="card__subtitle">Войдите по API-ключу Wello, чтобы агент работал от вашего аккаунта.</p>
            <label className="field">
              <span className="label">Ключ Wello</span>
              <div className="field__reveal">
                <input
                  className="input"
                  type={show ? "text" : "password"}
                  placeholder="wlo_live_…"
                  value={key}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitKey();
                  }}
                />
                <button
                  type="button"
                  className="field__reveal-btn"
                  aria-label={show ? "Скрыть ключ" : "Показать ключ"}
                  title={show ? "Скрыть" : "Показать"}
                  onClick={() => setShow((v) => !v)}
                >
                  {show ? "Скрыть" : "Показать"}
                </button>
              </div>
            </label>
            {!keyLooksValid ? (
              <p className="field__hint">Ключ обычно начинается с «wlo_live_». Проверьте, что скопировали его целиком.</p>
            ) : null}
            {error ? <p className="field__error">{error}</p> : null}
            <button className="button primary block" disabled={busy || !canSubmit} onClick={() => void submitKey()}>
              {busy ? "Подключение…" : "Подключить"}
            </button>
            <p className="card__hint">
              Ключ хранится в системном хранилище учётных данных и не попадает в проект.{" "}
              <button type="button" className="card__link" onClick={() => switchVia("account")}>
                Войти через аккаунт Wello
              </button>
            </p>
          </>
        )}
      </section>
    </main>
  );
}

/** Permission modes, mirroring the engine (legacy ask/build map to manual). */
const PERM_MODES: { id: TaskMode; label: string; hint: string; warn?: boolean }[] = [
  { id: "manual", label: "Вручную", hint: "Спрашивать разрешение на действия" },
  { id: "acceptEdits", label: "Принимать правки", hint: "Правки файлов — без вопросов" },
  { id: "plan", label: "План", hint: "Только план, без выполнения" },
  { id: "auto", label: "Авто", hint: "Модель сама решает, когда спросить" },
  // The id stays "bypass" (stored in localStorage/engine mapping) — only the
  // visible wording changed, so saved selections survive the rename.
  { id: "bypass", label: "Полный доступ", hint: "Действует без подтверждений. Рискованно", warn: true },
];
const MODE_LS_KEY = "wello-code-mode";

function initialMode(): TaskMode {
  const saved = localStorage.getItem(MODE_LS_KEY);
  if (PERM_MODES.some((m) => m.id === saved)) return saved as TaskMode;
  return "manual";
}

// Haiku 4.5 is not offered in the Wello catalog; a stored selection of it falls
// back to Sonnet 5 via initialModel()'s validation.
const MODELS: { id: string; label: string; hint: string }[] = [
  { id: "claude-sonnet-5", label: "Sonnet 5", hint: "Баланс скорости и качества" },
  { id: "claude-opus-4-8", label: "Opus 4.8", hint: "Сложные задачи, максимум качества" },
  { id: "claude-fable-5", label: "Fable 5", hint: "Флагман с размышлениями" },
];
const MODEL_LS_KEY = "wello-code-model";

function initialModel(): string {
  const saved = localStorage.getItem(MODEL_LS_KEY);
  return MODELS.some((m) => m.id === saved) ? saved! : MODELS[0]!.id;
}

/**
 * Reasoning effort steps for the Faster ↔ Smarter slider (engine default: high).
 * The sixth position, «Ультра», is not a deeper thinking level — it is the
 * ultracode mode: xhigh effort plus standing subagent orchestration.
 */
const EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
type Effort = (typeof EFFORTS)[number];
const EFFORT_LABEL: Record<Effort, string> = {
  low: "Минимум",
  medium: "Средне",
  high: "Высоко",
  xhigh: "Очень высоко",
  max: "Максимум",
  ultra: "Ультра",
};
const EFFORT_LS_KEY = "wello-code-effort";

function initialEffort(): Effort {
  const saved = localStorage.getItem(EFFORT_LS_KEY) as Effort | null;
  return saved && EFFORTS.includes(saved) ? saved : "high";
}

/** Below this the titlebar balance turns amber — a gentle "top up soon" cue. */
const LOW_BALANCE_CENTS = 100;
const BILLING_URL = "https://wello.dev/settings/billing";

/** Human plan names for the subscription chip (fall back to «Подписка»). */
const PLAN_LABELS: Record<string, string> = {
  pro: "Pro",
  max5: "Max 5×",
  max20: "Max 20×",
};

/** The plan label for the account row and the settings profile chip. */
function planLabelOf(
  billing: Connection["billing"],
  planId: string | null | undefined,
): string {
  return billing === "subscription"
    ? (PLAN_LABELS[planId ?? ""] ?? "Подписка")
    : billing === "blocked"
      ? "Без тарифа"
      : "Оплата по факту";
}

function Workspace({
  connection,
  onDisconnect,
}: {
  connection: Connection | null;
  onDisconnect: () => void;
}) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [mode, setMode] = useState<TaskMode>(initialMode);
  const [model, setModel] = useState<string>(initialModel);
  const [effort, setEffort] = useState<Effort>(initialEffort);
  const [prompt, setPrompt] = useState("");
  const [state, dispatch] = useReducer(tasksReducer, initialTasksState);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  // The right-hand panel dock (Claude Code style): open tools tile one column.
  // The set, the maximized tile and the dock width survive restarts (file tabs
  // don't — their paths belong to whatever workspace was open back then).
  const [panels, setPanels] = useState<PanelId[]>(
    () => restorablePanels(loadDockPrefs()) as PanelId[],
  );
  const [maximizedPanel, setMaximizedPanel] = useState<PanelId | null>(() => {
    const prefs = loadDockPrefs();
    return prefs.max && restorablePanels(prefs).includes(prefs.max)
      ? (prefs.max as PanelId)
      : null;
  });
  const [stackWidth, setStackWidth] = useState<number>(() => {
    const saved = loadDockPrefs().w;
    return typeof saved === "number" && Number.isFinite(saved) && saved >= DOCK_MIN ? saved : 440;
  });
  useEffect(() => {
    saveDockPrefs({
      panels: panels.filter((p) => !p.startsWith("file:")),
      max: maximizedPanel && !maximizedPanel.startsWith("file:") ? maximizedPanel : null,
    });
  }, [panels, maximizedPanel]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Settings mode state: the open page (persisted — reopening lands where you
  // left) and the settings-nav collapse (the titlebar sidebar toggle / Ctrl+B
  // drive THIS while settings are up).
  const [settingsPage, setSettingsPageState] = useState<SettingsPageId>(loadLastSettingsPage);
  const [settingsNavOpen, setSettingsNavOpen] = useState(true);
  const setSettingsPage = useCallback((p: SettingsPageId): void => {
    setSettingsPageState(p);
    saveLastSettingsPage(p);
  }, []);
  const [refreshKey, setRefreshKey] = useState(0);
  const [balanceCents, setBalanceCents] = useState<number | null>(connection?.balanceCents ?? null);
  // Subscription billing chip (/code API): plan-first funding since phase 2.
  // Carries the account identity too (e-mail + web display name) for the
  // sidebar-footer account row.
  const [subInfo, setSubInfo] = useState<
    Pick<Connection, "billing" | "planId" | "planActive" | "usedFraction" | "email" | "displayName">
  >({
    billing: connection?.billing,
    planId: connection?.planId ?? null,
    planActive: connection?.planActive,
    usedFraction: connection?.usedFraction ?? null,
    email: connection?.email ?? null,
    displayName: connection?.displayName ?? null,
  });
  // Subscription gate: Wello Code is a Pro+ perk. Without a plan we offer PAYG
  // (one acknowledged choice, persisted) or the paywall CTAs when even PAYG
  // can't fund a turn. Never shown to an active subscriber.
  const [gateClosed, setGateClosed] = useState(false);
  const [taskMenuId, setTaskMenuId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; title: string } | null>(null);
  // Sign-out asks for confirmation (one modal for the footer menu AND settings).
  const [signOutAsk, setSignOutAsk] = useState(false);
  // Main held a window close because a run is in flight — confirm before quitting.
  const [closeAsk, setCloseAsk] = useState(false);
  const [bypassAsk, setBypassAsk] = useState(false);
  const [ultraAsk, setUltraAsk] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [chatQuery, setChatQuery] = useState("");
  // The list filters on a ~150ms debounce of the field — typing stays instant,
  // the grouping work runs once per pause instead of per keystroke.
  const [filterQuery, setFilterQuery] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setFilterQuery(chatQuery), 150);
    return () => window.clearTimeout(t);
  }, [chatQuery]);
  const searchRef = useRef<HTMLInputElement>(null);
  // Back/forward over screens (chat ids + null = home), Claude Code style. Every
  // activeId transition lands here; nav-button jumps set `navSuppress` so the
  // observer records the MOVE of the cursor, not a new entry.
  const [nav, setNav] = useState<{ stack: (string | null)[]; index: number }>({
    stack: [],
    index: -1,
  });
  const navSuppress = useRef(false);
  // Chat-title dropdown (rename/pin/delete/project) in the chat column header.
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  // Account row menu in the sidebar footer. The row is the fixed menu's anchor
  // (the menu portals out of the sidebar). The app version lives in Settings →
  // «О приложении» now, not here.
  const [acctOpen, setAcctOpen] = useState(false);
  const acctRowRef = useRef<HTMLButtonElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [limitNote, setLimitNote] = useState<string | null>(null);
  const [plusOpen, setPlusOpen] = useState(false);
  // Messages typed while the agent is still working: they stack here (FIFO)
  // and auto-send one per finished run of their task (Claude Code type-ahead).
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  // Editing an earlier user turn: the composer holds the corrected text and the
  // send forks the engine session at `anchorUuid` (null = re-start from scratch).
  const [editing, setEditing] = useState<{ itemId: string; anchorUuid: string | null } | null>(null);
  // Rewind confirmation (restoring files is destructive) — the target turn.
  const [rewindAsk, setRewindAsk] = useState<{ itemId: string; runId: string } | null>(null);
  // @-mention file picker (Claude Code style): active query, ranked candidates,
  // highlighted row, and a per-workspace file-list cache.
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  // Slash-command menu (mutually exclusive with @-mentions).
  const [slash, setSlash] = useState<SlashQuery | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  // The trusted project's own .claude/commands (refreshed on folder/trust change).
  const [projectCommands, setProjectCommands] = useState<
    Array<{ name: string; description: string; argumentHint?: string; body: string }>
  >([]);
  const mentionCacheRef = useRef<{ path: string; files: string[] } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // The composer ELEMENT (not the textarea) + the empty-state title, for the
  // first-send FLIP: the composer glides from the centered empty state into its
  // docked position without remounting (focus and draft survive). The ref is
  // armed ONLY by the create path — opening an existing chat snaps instantly.
  const composerElRef = useRef<HTMLDivElement>(null);
  const homeTitleRef = useRef<HTMLHeadingElement>(null);
  const homeFlipRef = useRef<{ top: number } | null>(null);
  // The first-send scene window: while set, the freshly mounted first message
  // waits ~250ms and slides in from below (CSS .is-first-turn) instead of
  // popping the instant the composer starts falling.
  const [firstTurnScene, setFirstTurnScene] = useState(false);
  const prevRunning = useRef(false);
  const hydrated = useRef(false);
  // Per-chat composer drafts (kept in memory for the session): switching chats no
  // longer carries your half-typed message into the wrong one.
  const draftsRef = useRef<Map<string, string>>(new Map());
  // ↑/↓ prompt history (terminal style): the walk state lives in a ref — it
  // resets on chat switch and on send, never on re-render.
  const histNavRef = useRef<HistoryNav>({ index: null, stash: "" });

  const activeTask = state.tasks.find((t) => t.id === state.activeId) ?? null;
  const activeRunning = activeTask?.agent.running ?? false;
  const pending = activeTask?.agent.pending ?? null;
  const question = activeTask?.agent.question ?? null;
  const ghConnect = activeTask?.agent.githubConnect ?? null;
  // Background tasks blocked waiting for an answer (permission/question) — surfaced
  // globally so a background run doesn't hang unnoticed while another chat is open.
  const waitingTasks = state.tasks.filter(
    (t) => t.id !== activeTask?.id && (t.agent.pending || t.agent.question || t.agent.githubConnect),
  );
  // Each chat is bound to its own folder; the global `workspace` is only the
  // pick for the NEXT new chat. Everything folder-scoped follows the open chat.
  const activePath = activeTask ? (activeTask.workspacePath ?? workspace?.path ?? null) : (workspace?.path ?? null);
  // File-panel ids are workspace-RELATIVE — when the active folder actually
  // changes (chat switch, first folder pick) the open file cards would silently
  // resolve against the NEW root (wrong project's file, or "not found"). Drop them
  // exactly on that transition.
  const prevPathRef = useRef(activePath);
  useEffect(() => {
    if (prevPathRef.current === activePath) return;
    prevPathRef.current = activePath;
    setPanels((p) => p.filter((id) => !id.startsWith("file:")));
    setMaximizedPanel((m) => (m?.startsWith("file:") ? null : m));
  }, [activePath]);
  // A nearly-full context window — nudge toward a fresh task before early detail is lost.
  const ctx = activeTask?.agent;
  const contextHigh =
    !!ctx &&
    !ctx.running &&
    ctx.contextUsedTokens != null &&
    ctx.contextUsedTokens / (ctx.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW) >= 0.9;

  useEffect(
    () =>
      window.wello.onAgentEvent((event) => {
        dispatch({ type: "event", event });
        // Per-task follow-ups on terminal events — keyed by the EVENT's task, so
        // background runs get their change-set card and title too, not only the
        // task the user happens to be looking at.
        if (event.type === "run.completed" || event.type === "run.failed") {
          const taskId = event.taskId;
          if (taskId) {
            void loadChangesRef.current(taskId);
            void titleTaskRef.current(taskId);
            if (event.type === "run.completed") {
              // A SUCCESSFUL finish sends the task's WHOLE queue as one merged
              // follow-up (Claude Code) — five stacked lines cost one run.
              const batch = queueRef.current.filter((m) => m.taskId === taskId);
              if (batch.length > 0) {
                setQueue((prev) => prev.filter((m) => m.taskId !== taskId));
                flushQueuedRef.current(taskId, batch);
              }
            } else {
              // A FAILED run must not machine-gun the queue into more failing
              // runs — hand the queued texts back instead (composer / draft).
              returnQueueRef.current(taskId);
            }
          }
        }
        // Engine-side cancellation (not our Stop button): same rule — queued
        // messages never ride into a cancelled task, they come back as text.
        if (event.type === "run.status_changed" && event.data.to === "cancelled" && event.taskId) {
          returnQueueRef.current(event.taskId);
        }
      }),
    [],
  );

  // Window close held by main mid-run: confirm, or let it through when the last
  // run finished during the round-trip (race). The running check reads a ref —
  // the subscription mounts once.
  const anyRunningRef = useRef(false);
  anyRunningRef.current = state.tasks.some((t) => t.agent.running);
  useEffect(
    () =>
      window.wello.onCloseRequested(() => {
        if (anyRunningRef.current) setCloseAsk(true);
        else void window.wello.confirmClose();
      }),
    [],
  );

  // Restore the previous session (tasks + last workspace + composer drafts) once.
  useEffect(() => {
    void window.wello.loadState().then((persisted) => {
      if (persisted) {
        if (persisted.workspace) setWorkspace(persisted.workspace);
        if (persisted.drafts) draftsRef.current = new Map(Object.entries(persisted.drafts));
        dispatch({
          type: "hydrate",
          tasks: persisted.tasks as TaskItem[],
          activeId: persisted.activeId,
        });
        // Put the active chat's saved draft back into the composer.
        const activeDraft = persisted.activeId
          ? persisted.drafts?.[draftKey(persisted.activeId)]
          : persisted.drafts?.[draftKey(null)];
        if (activeDraft) setPrompt(activeDraft);
      }
      hydrated.current = true;
    });
  }, []);

  // Debounced autosave — but never before the restore finished (an early save
  // would clobber the previous session with an empty one). The composer draft
  // rides along: the active chat's live text is folded into the drafts map so a
  // half-typed message survives a restart even without switching chats first.
  useEffect(() => {
    if (!hydrated.current) return;
    const id = setTimeout(() => {
      const drafts: Record<string, string> = {};
      for (const [k, v] of draftsRef.current) if (v.trim()) drafts[k] = v;
      const activeKey = draftKey(state.activeId);
      if (prompt.trim() && !editing) drafts[activeKey] = prompt;
      else delete drafts[activeKey];
      void window.wello.saveState({
        version: 1,
        workspace,
        activeId: state.activeId,
        tasks: state.tasks,
        drafts,
      });
    }, 600);
    return () => clearTimeout(id);
  }, [state, workspace, prompt, editing]);

  // Follow the stream only while the user is at (or near) the bottom — never
  // yank the view down while they are reading earlier turns. The 120px pin
  // drives the streaming auto-follow (unchanged); the jump-down button uses its
  // own, larger threshold so it only appears once you're genuinely away.
  const pinnedToBottom = useRef(true);
  const [farFromBottom, setFarFromBottom] = useState(false);
  const onConversationScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - (el.scrollTop + el.clientHeight);
    pinnedToBottom.current = dist < 120;
    const far = dist > 200;
    setFarFromBottom((prev) => (prev === far ? prev : far));
  };
  const scrollToLatest = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    pinnedToBottom.current = true;
    setFarFromBottom(false);
  };
  useEffect(() => {
    if (pinnedToBottom.current) {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }
  }, [activeTask?.agent.items, pending, question, ghConnect, queue.length]);
  useEffect(() => {
    // Switching tasks always lands at the latest message.
    pinnedToBottom.current = true;
    setFarFromBottom(false);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [state.activeId]);

  // ── Settings mode enter/exit ────────────────────────────────────────────────
  // Settings replace the whole work area (the chat column unmounts), so the
  // conversation's scroll offset is captured on the way in and put back right
  // after the chat re-renders — together with the untouched task selection and
  // the dock (which only hides via CSS) the app comes back EXACTLY as left.
  const savedChatScrollRef = useRef<number | null>(null);
  const openSettings = useCallback((): void => {
    savedChatScrollRef.current = scrollRef.current?.scrollTop ?? null;
    setSettingsOpen(true);
  }, []);
  const closeSettings = useCallback((): void => setSettingsOpen(false), []);
  const toggleSettings = useCallback((): void => {
    setSettingsOpen((open) => {
      if (!open) savedChatScrollRef.current = scrollRef.current?.scrollTop ?? null;
      return !open;
    });
  }, []);
  useLayoutEffect(() => {
    if (settingsOpen || savedChatScrollRef.current == null) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = savedChatScrollRef.current;
    savedChatScrollRef.current = null;
  }, [settingsOpen]);

  // ── Branch chip (local git, stage 1) ────────────────────────────────────────
  // The current branch under the composer. Refreshed on folder/task switch, when
  // a run finishes, on window focus and after commit/init from the review panel.
  const [branch, setBranch] = useState<GitBranchInfo | null>(null);
  // Stage 2: the remote picture (origin/upstream/ahead/behind) rides along.
  const [sync, setSync] = useState<GitSyncInfo | null>(null);
  // Merge/rebase conflict state — refreshed together with the branch chip.
  const [conflicts, setConflicts] = useState<GitConflictInfo | null>(null);
  const [conflictAsk, setConflictAsk] = useState(false);
  const [branchPopOpen, setBranchPopOpen] = useState(false);
  const branchChipRef = useRef<HTMLButtonElement>(null);
  const branchPathRef = useRef<string | null>(null);
  branchPathRef.current = activePath;
  const refreshBranch = async (): Promise<void> => {
    const path = branchPathRef.current;
    if (!path) {
      setBranch(null);
      setSync(null);
      setConflicts(null);
      return;
    }
    const info = await window.wello.gitBranchInfo(path).catch(() => null);
    // A late answer for a folder the user already left must not stick.
    if (branchPathRef.current !== path) return;
    setBranch(info);
    if (info?.isRepo && !info.gitMissing) {
      const [s, c] = await Promise.all([
        window.wello.gitSyncInfo(path).catch(() => null),
        window.wello.gitConflictInfo(path).catch(() => null),
      ]);
      if (branchPathRef.current === path) {
        setSync(s);
        setConflicts(c);
      }
    } else {
      setSync(null);
      setConflicts(null);
    }
  };
  const refreshBranchRef = useRef(refreshBranch);
  refreshBranchRef.current = refreshBranch;
  useEffect(() => {
    setBranchPopOpen(false); // the popover belongs to the folder it opened on
    void refreshBranchRef.current();
  }, [activePath]);
  // Each chat gets its own ↑-history walk; switching chats leaves none behind.
  // An in-progress turn edit doesn't survive the switch either — its text stays
  // in the composer as an ordinary draft, but the fork anchor is dropped.
  useEffect(() => {
    histNavRef.current = { index: null, stash: "" };
    setEditing(null);
  }, [state.activeId]);
  useEffect(() => {
    const onFocus = (): void => {
      void refreshBranchRef.current();
      void refreshWorkspaceMetaRef.current();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // ── Workspace trust + project instructions (CLAUDE.md) ──────────────────────
  // Trust decides whether the engine loads PROJECT-level settings and whether
  // persistent grants exist; the instructions chip names the CLAUDE.md/AGENTS.md
  // the agent picks up. Both follow the open chat's folder.
  const [wsTrust, setWsTrust] = useState<WorkspaceTrust | null>(null);
  // Same value as a ref: the send gate reads THIS, because the resumed send
  // closure is from the pre-decision render — its `wsTrust` const would still
  // say "undecided" and re-open the modal in a loop.
  const wsTrustRef = useRef<WorkspaceTrust | null>(null);
  const [instructionsFile, setInstructionsFile] = useState<string | null>(null);
  // The trust question as a modal; `afterTrustRef` resumes a send that was
  // waiting on the decision (either answer resumes — the runtime enforces).
  const [trustAsk, setTrustAsk] = useState<{ path: string; name: string } | null>(null);
  const afterTrustRef = useRef<(() => void) | null>(null);
  const trustPathRef = useRef<string | null>(null);
  trustPathRef.current = activePath;
  const applyWsTrust = (trust: WorkspaceTrust | null): void => {
    wsTrustRef.current = trust;
    setWsTrust(trust);
  };
  const refreshWorkspaceMeta = async (): Promise<void> => {
    const path = trustPathRef.current;
    if (!path) {
      applyWsTrust(null);
      setInstructionsFile(null);
      return;
    }
    const [trust, instr] = await Promise.all([
      window.wello.getWorkspaceTrust(path).catch(() => null),
      window.wello.workspaceInstructions(path).catch(() => ({ file: null as string | null })),
    ]);
    // A late answer for a folder the user already left must not stick.
    if (trustPathRef.current !== path) return;
    if (trust) applyWsTrust(trust);
    setInstructionsFile(instr?.file ?? null);
  };
  const refreshWorkspaceMetaRef = useRef(refreshWorkspaceMeta);
  refreshWorkspaceMetaRef.current = refreshWorkspaceMeta;
  useEffect(() => {
    wsTrustRef.current = null;
    setWsTrust(null);
    setInstructionsFile(null);
    void refreshWorkspaceMetaRef.current();
  }, [activePath]);
  // Project slash commands follow the open folder AND its trust (main returns
  // [] for an untrusted workspace); re-scanned after a run in case one was added.
  useEffect(() => {
    if (!activePath || !wsTrust?.trusted) {
      setProjectCommands([]);
      return;
    }
    let live = true;
    void window.wello
      .listProjectCommands(activePath)
      .then((cmds) => {
        if (live) setProjectCommands(cmds);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [activePath, wsTrust?.trusted, refreshKey]);
  // Restricted = the user explicitly chose NOT to trust this folder. An undecided
  // folder shows no locks (the send gate asks first; the runtime isolates anyway).
  const restricted = wsTrust != null && wsTrust.decided && !wsTrust.trusted;
  const resolveTrust = (trusted: boolean): void => {
    const target = trustAsk;
    setTrustAsk(null);
    const resume = afterTrustRef.current;
    afterTrustRef.current = null;
    if (!target) return;
    // The ref flips SYNCHRONOUSLY so a resumed send (whose closed-over state
    // still says "undecided") passes the gate instead of re-opening the modal.
    if (trustPathRef.current === target.path) {
      wsTrustRef.current = { decided: true, trusted, grantedCaps: [] };
    }
    void window.wello
      .setWorkspaceTrust(target.path, trusted)
      .then(() => refreshWorkspaceMetaRef.current())
      .then(() => resume?.());
  };

  // First-send FLIP: the commit that created the task re-laid the composer at
  // the bottom — play the move from the remembered centered position (inverse
  // transform → transition to identity). Transform-only (no top/height/margin),
  // measured AFTER the full new layout (the thread + delayed-but-in-flow first
  // message are already in this commit, so there's no correction hop at the
  // end), will-change for the flight. No remount, no focus loss.
  useLayoutEffect(() => {
    const flip = homeFlipRef.current;
    if (!flip) return;
    homeFlipRef.current = null;
    const el = composerElRef.current;
    if (!el) return;
    const delta = flip.top - el.getBoundingClientRect().top;
    if (Math.abs(delta) < 2) return;
    el.style.transition = "none";
    el.style.willChange = "transform";
    el.style.transform = `translateY(${delta}px)`;
    void el.offsetHeight;
    // The sidebar's own curve (--ease-standard), on the motion scale's LONG
    // step — same character of movement, just a longer path.
    el.style.transition = "transform var(--motion-flight) var(--ease-standard)";
    el.style.transform = "";
    const done = (): void => {
      el.style.transition = "";
      el.style.willChange = "";
      el.removeEventListener("transitionend", done);
      window.clearTimeout(guard);
    };
    const guard = window.setTimeout(done, 700);
    el.addEventListener("transitionend", done);
  }, [state.activeId]);

  // The composer grows with its content (up to the CSS max-height).
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [prompt]);

  // After a history recall the caret belongs at the END of the recalled text
  // (a controlled-value swap leaves it wherever it was). setTimeout, not rAF —
  // rAF is frozen in a hidden window (see the terminal render lesson).
  const caretToEnd = (): void => {
    window.setTimeout(() => {
      const el = composerRef.current;
      if (!el) return;
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }, 0);
  };

  const loadChanges = async (taskId: string): Promise<void> => {
    const task = state.tasks.find((t) => t.id === taskId);
    const path = task?.workspacePath ?? workspace?.path;
    if (!path) return;
    const summary = await window.wello.reviewSummary(path, taskId);
    dispatch({ type: "setChanges", taskId, changes: summary.backing !== "none" ? summary : null });
  };

  // First finished turn: swap the prompt-derived placeholder for a real title.
  const titleTask = async (taskId: string): Promise<void> => {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task || task.title !== titleFromPrompt(task.prompt)) return;
    const title = await window.wello.generateTitle(task.prompt);
    if (title) dispatch({ type: "rename", taskId, title });
  };

  // The event subscription is created once; these refs keep its callbacks bound
  // to the latest workspace/tasks without resubscribing.
  const loadChangesRef = useRef(loadChanges);
  loadChangesRef.current = loadChanges;
  const titleTaskRef = useRef(titleTask);
  titleTaskRef.current = titleTask;
  // Queued type-ahead message + its sender, read from the (once-bound) event
  // subscription. `flushQueuedRef` is assigned after sendToTask is defined below.
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const flushQueuedRef = useRef<(taskId: string, batch: QueuedMessage[]) => void>(() => {});
  const returnQueueRef = useRef<(taskId: string) => void>(() => {});

  useEffect(() => {
    if (prevRunning.current && !activeRunning) {
      setRefreshKey((k) => k + 1);
      // The agent may have touched the repo (or even run git itself).
      void refreshBranchRef.current();
      // …or created/edited CLAUDE.md — keep the instructions chip honest.
      void refreshWorkspaceMetaRef.current();
      // The run spent money — show the fresh balance/plan usage and hand focus back.
      void window.wello.getConnection().then((c) => {
        if (c.balanceCents != null) setBalanceCents(c.balanceCents);
        if (c.billing) {
          setSubInfo({
            billing: c.billing,
            planId: c.planId ?? null,
            planActive: c.planActive,
            usedFraction: c.usedFraction ?? null,
            email: c.email ?? null,
            displayName: c.displayName ?? null,
          });
        }
      });
      composerRef.current?.focus();
    }
    prevRunning.current = activeRunning;
  }, [activeRunning]);

  const selectModel = (id: string): void => {
    setModel(id);
    localStorage.setItem(MODEL_LS_KEY, id);
  };

  const commitMode = (id: TaskMode): void => {
    setMode(id);
    localStorage.setItem(MODE_LS_KEY, id);
  };

  const selectMode = (id: TaskMode): void => {
    // Bypass disables every safety prompt — make the user acknowledge that.
    if (id === "bypass" && mode !== "bypass") {
      setBypassAsk(true);
      return;
    }
    commitMode(id);
  };

  const commitEffort = (id: Effort): void => {
    setEffort(id);
    localStorage.setItem(EFFORT_LS_KEY, id);
  };

  const selectEffort = (id: Effort): void => {
    // «Ультра» multiplies token burn — make the user acknowledge that once per switch.
    if (id === "ultra" && effort !== "ultra") {
      setUltraAsk(true);
      return;
    }
    commitEffort(id);
  };

  /** Adds a panel tile to the dock (or surfaces it when it's hidden).
   *  Any panel action taken from the settings screen first returns to the chat —
   *  the dock is only VISUALLY hidden there, so the toggle must land somewhere
   *  the user can see. */
  const openPanel = (id: PanelId): void => {
    setSettingsOpen(false);
    setPanels((p) => (p.includes(id) ? p : [...p, id]));
    // Opening something new while another tile is maximized would land it
    // invisible — level the tiles instead.
    setMaximizedPanel((m) => (m !== null && m !== id ? null : m));
  };

  const closePanel = (id: PanelId): void => {
    setPanels((p) => p.filter((x) => x !== id));
    setMaximizedPanel((m) => (m === id ? null : m));
  };

  const togglePanel = (id: PanelId): void => {
    setSettingsOpen(false);
    if (panels.includes(id)) closePanel(id);
    else openPanel(id);
  };

  const toggleMaxPanel = (id: PanelId): void => {
    setMaximizedPanel((m) => (m === id ? null : id));
  };

  const openFileTab = (path: string): void => openPanel(`file:${path}`);

  const openFolder = async (): Promise<void> => {
    const ws = await window.wello.openWorkspace();
    // File-panel cleanup is NOT done here: it keys off the actual activePath
    // transition (effect below) — picking a folder for the NEXT chat must not
    // wipe the current chat's open file cards.
    if (ws) {
      setWorkspace(ws);
      // A folder this install has never seen: ask about trust right away, while
      // the choice is still on the user's mind (the send gate is the backstop).
      const trust = await window.wello.getWorkspaceTrust(ws.path).catch(() => null);
      if (trust && !trust.decided) setTrustAsk({ path: ws.path, name: ws.name });
    }
  };

  /** Continue a SPECIFIC task with a follow-up turn (its own folder + session).
   *  Used both by the active-composer send and by the queued type-ahead flush,
   *  so a message queued for one task lands in it even if the user switched away. */
  const sendToTask = async (task: TaskItem, fullText: string, content: TurnContent): Promise<void> => {
    const taskPath = task.workspacePath ?? workspace?.path;
    if (!taskPath) return;
    // Any ordinary turn supersedes a half-started edit (retry, /init, the
    // conflict helper all route here) — the stale fork anchor must not survive.
    setEditing(null);
    const runId = crypto.randomUUID();
    dispatch({
      type: "followup",
      taskId: task.id,
      runId,
      mode,
      prompt: content.shown ?? fullText,
      images: content.images,
      attachments: content.attachments,
      fullText,
    });
    await window.wello.startRun({
      taskId: task.id,
      runId,
      workspaceId: task.id,
      workspacePath: taskPath,
      mode,
      prompt: fullText,
      model,
      effort,
      resumeSessionId: task.sessionId ?? undefined,
    });
  };

  const sendText = async (fullText: string, content: TurnContent = {}): Promise<void> => {
    if (!fullText || activeRunning) return;
    const shown = content.shown ?? fullText;
    const turn = {
      prompt: shown,
      images: content.images,
      attachments: content.attachments,
      fullText,
    };
    const runId = crypto.randomUUID();
    // An open task = a conversation to continue IN ITS OWN folder.
    if (activeTask) {
      return sendToTask(activeTask, fullText, content);
    }
    // A new chat requires a folder picked in the strip above the composer.
    if (!workspace) return;
    // The FIRST send leaves the centered empty state — one continuous top-down
    // scene, not three simultaneous jolts: at t=0 the title fades up and out
    // (180ms) while the composer starts its 520ms expo-out fall; the user's
    // message then arrives ~250ms in (see .is-first-turn), when the composer
    // has already covered most of the distance. Reduced motion skips it all.
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const composerEl = composerElRef.current;
      if (composerEl) homeFlipRef.current = { top: composerEl.getBoundingClientRect().top };
      setFirstTurnScene(true);
      window.setTimeout(() => setFirstTurnScene(false), 900);
      const titleEl = homeTitleRef.current;
      if (titleEl) {
        const r = titleEl.getBoundingClientRect();
        const ghost = titleEl.cloneNode(true) as HTMLElement;
        ghost.classList.remove("wello-rise");
        ghost.classList.add("hometitle--ghost");
        ghost.style.top = `${r.top}px`;
        ghost.style.left = `${r.left}px`;
        ghost.style.width = `${r.width}px`;
        document.body.appendChild(ghost);
        void ghost.offsetHeight; // paint in place, then transition out
        ghost.style.opacity = "0";
        ghost.style.transform = "translateY(-8px)";
        window.setTimeout(() => ghost.remove(), 260);
      }
    }
    const taskId = crypto.randomUUID();
    dispatch({
      type: "create",
      id: taskId,
      title:
        titleFromPrompt(shown) ||
        content.attachments?.[0]?.label ||
        (content.images?.length ? "Изображение" : "Новая задача"),
      mode,
      runId,
      workspacePath: workspace.path,
      workspaceName: workspace.name,
      ...turn,
    });
    const input: StartRunInput = {
      taskId,
      runId,
      workspaceId: taskId,
      workspacePath: workspace.path,
      mode,
      prompt: fullText,
      model,
      effort,
    };
    await window.wello.startRun(input);
  };

  const send = async (): Promise<void> => {
    const text = prompt.trim();
    if (!text && attachments.length === 0) return;
    // New chat without a folder yet: open the picker instead of silently doing
    // nothing. (The send button is disabled here, so this fires from Enter.)
    if (!activeTask && !workspace) {
      void openFolder();
      return;
    }
    // The trust question was never answered for this folder (e.g. the picker
    // modal was dismissed): ask now and resume this send after the decision.
    // Both reads go through refs — the resumed closure is a stale render.
    if (activePath && wsTrustRef.current && !wsTrustRef.current.decided) {
      setTrustAsk({
        path: activePath,
        name: activeTask?.workspaceName ?? workspace?.name ?? activePath,
      });
      afterTrustRef.current = () => void sendRef.current();
      return;
    }
    const atts = attachments;
    const content: TurnContent = {
      shown: text,
      images: atts.flatMap((a) => (a.kind === "image" ? [a.path] : [])),
      attachments: attachmentMeta(atts),
    };
    const fullText = buildPrompt(text, atts);
    setPrompt("");
    setAttachments([]);
    setLimitNote(null);
    draftsRef.current.delete(draftKey(state.activeId));
    histNavRef.current = { index: null, stash: "" }; // the walk ends with the send
    // Editing an earlier turn: truncate the timeline at that message and fork
    // the engine session at the pre-edit anchor (probed live: the forked run
    // sees only the history up to the anchor; the original session stays intact).
    // Never while a run is in flight — a retry/conflict turn may have started
    // since the edit began, and truncating under a streaming run would corrupt
    // the timeline and double-run the task.
    if (editing && activeTask) {
      if (activeRunning) {
        setEditing(null);
        return;
      }
      const edit = editing;
      setEditing(null);
      const taskPath = activeTask.workspacePath ?? workspace?.path;
      if (!taskPath) return;
      const runId = crypto.randomUUID();
      dispatch({
        type: "editTurn",
        taskId: activeTask.id,
        itemId: edit.itemId,
        runId,
        mode,
        prompt: content.shown ?? fullText,
        images: content.images,
        attachments: content.attachments,
        fullText,
      });
      await window.wello.startRun({
        taskId: activeTask.id,
        runId,
        workspaceId: activeTask.id,
        workspacePath: taskPath,
        mode,
        prompt: fullText,
        model,
        effort,
        ...(edit.anchorUuid && activeTask.sessionId
          ? { resumeSessionId: activeTask.sessionId, resumeAtMessageUuid: edit.anchorUuid }
          : {}),
      });
      return;
    }
    // Typed while the agent is still working: stack it and auto-send when this
    // task's runs end, FIFO (Claude Code type-ahead — several may queue up; the
    // composer stays live for the next one). Never queues on the empty/home
    // composer. The bubble renders at the thread's tail with a remove ✕.
    if (activeRunning && activeTask) {
      setQueue((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          taskId: activeTask.id,
          fullText,
          content,
          preview: text || content.attachments?.[0]?.label || "Вложение",
        },
      ]);
      setPrompt("");
      setAttachments([]);
      const el = composerRef.current;
      if (el) el.style.height = "auto";
      return;
    }
    await sendText(fullText, content);
  };

  // The freshest send() for resumed closures (the trust modal's continue).
  const sendRef = useRef(send);
  sendRef.current = send;

  // Auto-send a task's queued type-ahead stack — merged into ONE follow-up turn
  // (Claude Code): texts join with blank lines, images/attachments concatenate.
  const flushQueued = (taskId: string, batch: QueuedMessage[]): void => {
    const task = state.tasks.find((t) => t.id === taskId);
    const merged = mergeQueued(batch);
    if (task && merged) void sendToTask(task, merged.fullText, merged.content);
  };
  flushQueuedRef.current = flushQueued;

  /** A task's run ended WITHOUT success (failed / cancelled / Stop): its queued
   *  messages must not ride on — their texts come back to the composer (active
   *  chat) or into that chat's draft, so nothing is lost and nothing self-runs. */
  const returnQueue = (taskId: string): void => {
    const mine = queueRef.current.filter((m) => m.taskId === taskId);
    if (mine.length === 0) return;
    setQueue((prev) => prev.filter((m) => m.taskId !== taskId));
    const joined = mine.map((m) => m.preview).join("\n\n");
    if (taskId === state.activeId) {
      setPrompt((prev) => [prev.trim(), joined].filter(Boolean).join("\n\n"));
    } else {
      const key = draftKey(taskId);
      const prev = draftsRef.current.get(key) ?? "";
      draftsRef.current.set(key, [prev.trim(), joined].filter(Boolean).join("\n\n"));
    }
  };
  returnQueueRef.current = returnQueue;

  /** Begin editing an earlier user turn: prefill the composer with its text (and
   *  its images as live attachments), remember the fork anchor — the last engine
   *  message BEFORE that turn. Null anchor = editing the very first turn. */
  const startEditTurn = (itemId: string): void => {
    const task = activeTask;
    if (!task || task.agent.running || queue.some((m) => m.taskId === task.id)) return;
    const items = task.agent.items;
    const idx = items.findIndex((i) => i.kind === "user" && i.id === itemId);
    if (idx === -1) return;
    const item = items[idx] as Extract<TimelineItem, { kind: "user" }>;
    let anchorUuid: string | null = null;
    for (let k = idx - 1; k >= 0; k--) {
      const prev = items[k]!;
      if (prev.kind === "message" && prev.sdkUuid) {
        anchorUuid = prev.sdkUuid;
        break;
      }
    }
    setEditing({ itemId, anchorUuid });
    setPrompt(item.text);
    setAttachments(
      (item.images ?? []).map((path) => ({ kind: "image" as const, id: crypto.randomUUID(), path })),
    );
    caretToEnd();
    composerRef.current?.focus();
  };

  const cancelEditTurn = (): void => {
    setEditing(null);
    setPrompt("");
    setAttachments([]);
  };

  /** Rewind: restore the project to a turn's pre-run checkpoint, then set up the
   *  edit (truncate + fork anchor) so the next send continues from that state. */
  const rewindToTurn = async (itemId: string, runId: string): Promise<void> => {
    const task = activeTask;
    if (!task || task.agent.running) return;
    const path = task.workspacePath;
    // Concurrent runs are supported and may point at the SAME folder — restoring
    // files under another task's live agent would corrupt its in-flight work.
    if (path && state.tasks.some((t) => t.workspacePath === path && t.agent.running)) {
      toast({ message: "В этой папке идёт другая задача — дождитесь её завершения", tone: "danger" });
      return;
    }
    if (path) {
      const ok = await window.wello.restoreCheckpoint(task.id, runId, path).catch(() => false);
      if (ok) {
        setRefreshKey((k) => k + 1);
        void refreshBranchRef.current();
        void loadChanges(task.id);
        toast({ message: "Проект возвращён к этому ходу", tone: "success" });
      } else {
        toast({ message: "Снимок файлов недоступен — откат только диалога", tone: "danger" });
      }
    }
    // Same edit machinery (prefill + fork anchor); the send truncates the tail.
    startEditTurn(itemId);
  };

  /** Save a chat's transcript to a Markdown file (OS save dialog picks the path). */
  const exportChat = async (task: TaskItem): Promise<void> => {
    const md = chatToMarkdown(task.title, task.agent.items);
    const ok = await window.wello.exportChat(task.title || "chat", md).catch(() => false);
    if (ok) toast({ message: "Диалог экспортирован", tone: "success" });
  };

  /** Start a fresh chat in the same folder, seeded with a handoff note that
   *  carries this chat's context — a manual /compact between conversations. */
  const continueInNewChat = async (task: TaskItem): Promise<void> => {
    toast({ message: "Готовлю передачу контекста…" });
    const transcript = transcriptForHandoff(task.agent.items);
    const note = await window.wello.generateHandoff(transcript, model).catch(() => null);
    // Land on the home composer bound to the SAME folder, so the first send
    // creates the new chat there.
    switchTo(null);
    if (task.workspacePath) {
      setWorkspace({
        id: crypto.randomUUID(),
        path: task.workspacePath,
        name: task.workspaceName ?? baseName(task.workspacePath),
      });
    }
    setPrompt(
      note
        ? `## Контекст предыдущего диалога\n\n${note}\n\n---\n\nПродолжаем: `
        : "",
    );
    if (!note) toast({ message: "Не удалось подготовить контекст — начните новый чат вручную", tone: "danger" });
    caretToEnd();
    composerRef.current?.focus();
  };

  /** Remove one queued message (its bubble's ✕) — Claude Code semantics: it is
   *  simply dropped, the composer keeps whatever is being typed next. */
  const removeQueued = (id: string): void => {
    setQueue((prev) => prev.filter((m) => m.id !== id));
  };

  /** Post the Claude-limits notice when something got rejected; true if all fit. */
  const noteRejects = (rejects: ReturnType<typeof admitAttachments>["rejects"]): void => {
    const note = limitNotice(rejects);
    if (note) setLimitNote(note);
  };

  // ---- @-mention file picker -------------------------------------------------
  /** Load (and cache per workspace) the file list the @-menu ranks against. */
  const ensureMentionFiles = async (): Promise<void> => {
    const wp = activePath;
    if (!wp) return;
    if (mentionCacheRef.current?.path === wp) {
      setMentionFiles(mentionCacheRef.current.files);
      return;
    }
    const files = await window.wello.listWorkspaceFiles(wp).catch(() => []);
    mentionCacheRef.current = { path: wp, files };
    setMentionFiles(files);
  };

  /** Re-evaluate the @-mention after the composer text or caret changed. Does NOT
   *  reset the highlighted row — that only resets on a text change (onChange), so
   *  arrow-key navigation isn't clobbered by the onKeyUp re-detect. */
  const refreshMention = (text: string, caret: number): void => {
    const m = activePath ? detectMention(text, caret) : null;
    setMention(m);
    if (m) void ensureMentionFiles();
  };

  /** A file chosen from the @-menu: strip the `@query` and attach the file. */
  const addMentionFile = async (rel: string): Promise<void> => {
    const wp = activePath;
    const m = mention;
    if (!wp || !m) return;
    setPrompt((p) => p.slice(0, m.start) + p.slice(m.start + 1 + m.query.length));
    setMention(null);
    composerRef.current?.focus();
    const abs = `${wp.replace(/\\/g, "/")}/${rel}`;
    if (attachments.some((a) => a.kind !== "paste" && a.path === abs)) return; // already attached
    const stats = await window.wello.statPaths([abs]).catch(() => []);
    const s = stats[0];
    if (!s) return;
    const kind = s.isDirectory ? "folder" : IMAGE_FILE_RE.test(abs) ? "image" : "file";
    const { accepted, rejects } = admitAttachments(attachments.length, [
      { kind, size: s.isDirectory ? null : s.size },
    ]);
    noteRejects(rejects);
    if (accepted.length === 0) return;
    setAttachments((prev) => [...prev, { kind, id: crypto.randomUUID(), path: abs }]);
  };

  const addFileAttachments = async (): Promise<void> => {
    const paths = await window.wello.pickFiles("Прикрепить файлы");
    if (paths.length === 0) return;
    const stats = await window.wello.statPaths(paths);
    const fresh = stats.filter(
      (s) => !attachments.some((a) => a.kind !== "paste" && a.path === s.path),
    );
    const kindOf = (s: (typeof fresh)[number]): "folder" | "image" | "file" =>
      s.isDirectory ? "folder" : IMAGE_FILE_RE.test(s.path) ? "image" : "file";
    const { accepted, rejects } = admitAttachments(
      attachments.length,
      fresh.map((s) => ({ kind: kindOf(s), size: s.isDirectory ? null : s.size })),
    );
    noteRejects(rejects);
    const adds = accepted.map((i) => fresh[i]!);
    if (adds.length > 0) {
      setAttachments((prev) => [
        ...prev,
        ...adds
          .filter((s) => !prev.some((a) => a.kind !== "paste" && a.path === s.path))
          .map((s) => ({ kind: kindOf(s), id: crypto.randomUUID(), path: s.path })),
      ]);
    }
    composerRef.current?.focus();
  };

  // A preview screenshot: attach it like a pasted image so the agent can Read it.
  const attachScreenshot = async (path: string): Promise<void> => {
    if (attachments.some((a) => a.kind !== "paste" && a.path === path)) return;
    const stats = await window.wello.statPaths([path]).catch(() => []);
    const { accepted, rejects } = admitAttachments(attachments.length, [
      { kind: "image", size: stats[0]?.size ?? 0 },
    ]);
    noteRejects(rejects);
    if (accepted.length === 0) return;
    setAttachments((prev) => [...prev, { kind: "image", id: crypto.randomUUID(), path }]);
    composerRef.current?.focus();
  };

  const addFolderAttachment = async (): Promise<void> => {
    const path = await window.wello.pickFolder("Прикрепить папку");
    if (!path) return;
    const { accepted, rejects } = admitAttachments(attachments.length, [{ kind: "folder" }]);
    noteRejects(rejects);
    if (accepted.length === 0) return;
    setAttachments((prev) =>
      prev.some((a) => a.kind !== "paste" && a.path === path)
        ? prev
        : [...prev, { kind: "folder", id: crypto.randomUUID(), path }],
    );
    composerRef.current?.focus();
  };

  /** Persist accepted images and attach them as thumbnail chips (no limit checks here). */
  const materializeImages = async (items: { blob: Blob; knownPath?: string }[]): Promise<void> => {
    const adds: Extract<Attachment, { kind: "image" }>[] = [];
    for (const it of items) {
      // Clipboard images are written to disk first; dropped files already live there.
      const path =
        it.knownPath ??
        (it.blob.size > 0
          ? await window.wello.savePastedImage(await it.blob.arrayBuffer(), it.blob.type || "image/png")
          : null);
      if (!path) continue;
      const preview = await blobToDataUrl(it.blob);
      adds.push({ kind: "image", id: crypto.randomUUID(), path, preview: preview ?? undefined });
    }
    if (adds.length > 0) {
      setAttachments((prev) => [
        ...prev,
        ...adds.filter((n) => !prev.some((a) => a.kind !== "paste" && a.path === n.path)),
      ]);
    }
    composerRef.current?.focus();
  };

  /** Clipboard/dropped images behind the Claude limits (20 per message, ≤10 МБ each). */
  const attachImageBlobs = async (items: { blob: Blob; knownPath?: string }[]): Promise<void> => {
    const { accepted, rejects } = admitAttachments(
      attachments.length,
      items.map((it) => ({ kind: "image" as const, size: it.blob.size })),
    );
    noteRejects(rejects);
    await materializeImages(accepted.map((i) => items[i]!));
  };

  /** Screenshots become image chips; big text pastes become a text chip. */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const images = Array.from(e.clipboardData.items).filter(
      (it) => it.kind === "file" && it.type.startsWith("image/"),
    );
    if (images.length > 0) {
      e.preventDefault();
      const files = images
        .map((it) => it.getAsFile())
        .filter((f): f is File => Boolean(f));
      void attachImageBlobs(files.map((f) => ({ blob: f })));
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    const lines = text.split("\n").length;
    if (text.length <= PASTE_CHARS && lines <= PASTE_LINES) return;
    const { accepted, rejects } = admitAttachments(attachments.length, [{ kind: "paste" }]);
    noteRejects(rejects);
    // No chip room left: let the default paste land in the textarea instead of losing it.
    if (accepted.length === 0) return;
    e.preventDefault();
    setAttachments((prev) => [
      ...prev,
      {
        kind: "paste",
        id: crypto.randomUUID(),
        label: `Вставка · ${lines} ${plural(lines, "строка", "строки", "строк")}`,
        text,
      },
    ]);
  };

  // --- Drag-n-drop: files/folders from the OS become attachment chips. -------
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  const onDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault(); // required, or the drop event never fires
    e.dataTransfer.dropEffect = activeRunning ? "none" : "copy";
  };
  const onDragEnter = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth.current += 1;
    setDragOver(true);
  };
  const onDragLeave = (): void => {
    // dragleave fires on every child boundary — only depth 0 really left.
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  };
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    if (activeRunning) return;
    // Everything off e.dataTransfer.items is read synchronously — the items are
    // invalidated by the first await.
    const drops: { path: string; isDirectory: boolean; file: File }[] = [];
    for (const item of Array.from(e.dataTransfer.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (!file) continue;
      const entry = item.webkitGetAsEntry?.();
      const path = window.wello.getPathForFile(file);
      if (path) drops.push({ path, isDirectory: entry?.isDirectory ?? false, file });
    }
    const plain = drops.filter((d) => d.isDirectory || !IMAGE_FILE_RE.test(d.path));
    const pictures = drops.filter((d) => !d.isDirectory && IMAGE_FILE_RE.test(d.path));
    // One Claude-limits admission for the whole drop (files first, then images).
    const { accepted, rejects } = admitAttachments(attachments.length, [
      ...plain.map((d) => ({
        kind: d.isDirectory ? ("folder" as const) : ("file" as const),
        size: d.isDirectory ? null : d.file.size,
      })),
      ...pictures.map((d) => ({ kind: "image" as const, size: d.file.size })),
    ]);
    noteRejects(rejects);
    const acceptedSet = new Set(accepted);
    const plainAdds = plain.filter((_, i) => acceptedSet.has(i));
    const pictureAdds = pictures.filter((_, i) => acceptedSet.has(plain.length + i));
    setAttachments((prev) => [
      ...prev,
      ...plainAdds
        .filter((d) => !prev.some((a) => a.kind !== "paste" && a.path === d.path))
        .map((d) => ({
          kind: d.isDirectory ? ("folder" as const) : ("file" as const),
          id: crypto.randomUUID(),
          path: d.path,
        })),
    ]);
    // Dropped pictures get the image treatment (thumbnail + "open with Read" hint).
    if (pictureAdds.length > 0) {
      void materializeImages(pictureAdds.map((d) => ({ blob: d.file, knownPath: d.path })));
    }
    composerRef.current?.focus();
  };

  // A drop that misses the zone must never navigate the window away.
  useEffect(() => {
    const swallow = (e: DragEvent): void => e.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  // Fresh view of the state the once-subscribed keyboard handler needs (whether a
  // focus-trapping modal is up, whether settings mode is on). Updated every render
  // below, read at key-press time. Esc deliberately does NOT stop the run —
  // stopping is the composer's Stop button; Esc keeps its dismiss roles (modals,
  // menus, search — handled by their owners) plus "leave settings" below.
  const hotkeyStateRef = useRef<{ modalOpen: boolean; settingsOpen: boolean }>({
    modalOpen: false,
    settingsOpen: false,
  });

  // Global shortcuts ride the shared registry (hotkeys.ts, matched by e.code so
  // keyboard layouts can't break them). Enter still sends (a chat-style choice),
  // so every combo stays modifier-only.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Esc leaves settings mode — but only as the LAST resort: open modals and
      // menus (they own Esc and are tracked as modalOpen) close first, and a
      // press inside any field (the settings search, the connector form) only
      // affects that field — the search consumes Esc itself, plain inputs blur.
      if (e.key === "Escape" && hotkeyStateRef.current.settingsOpen) {
        if (hotkeyStateRef.current.modalOpen) return;
        const t = e.target;
        if (t instanceof Element && t.closest("input, textarea, select, [contenteditable='true']"))
          return;
        e.preventDefault();
        closeSettings();
        return;
      }
      const id = matchHotkey(e);
      if (!id) return;
      // Don't let global shortcuts fire while a modal traps the user.
      if (hotkeyStateRef.current.modalOpen) return;
      switch (id) {
        case "palette":
          e.preventDefault();
          setPaletteOpen(true);
          break;
        case "chatSearch":
          e.preventDefault();
          // In settings mode the search IS the settings search.
          if (hotkeyStateRef.current.settingsOpen) {
            document.getElementById("setnav-search")?.focus();
          } else {
            focusChatSearchRef.current();
          }
          break;
        case "sidebar":
          // In settings mode the same chord collapses the settings nav instead.
          e.preventDefault();
          if (hotkeyStateRef.current.settingsOpen) setSettingsNavOpen((v) => !v);
          else setSidebarOpen((v) => !v);
          break;
        case "newTask":
          e.preventDefault();
          switchToRef.current(null);
          requestAnimationFrame(() => composerRef.current?.focus());
          break;
        case "settings":
          e.preventDefault();
          toggleSettings();
          break;
        case "terminal":
          e.preventDefault();
          if (activePathRef.current) togglePanelRef.current("terminal");
          else toast({ message: "Сначала откройте проект" });
          break;
        // "termNext" is scoped: the terminal panel handles it itself.
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeSettings, toggleSettings]);

  /** Re-run the last turn after a failure/cancel (the transcript keeps the note). */
  const retryLast = async (): Promise<void> => {
    if (!activeTask || activeRunning) return;
    const lastUser = [...activeTask.agent.items].reverse().find((it) => it.kind === "user");
    if (!lastUser || lastUser.kind !== "user") return;
    // The stored fullText carries the original paths/pastes — an honest resend.
    await sendText(lastUser.fullText ?? lastUser.text, {
      shown: lastUser.text,
      images: lastUser.images,
      attachments: lastUser.attachments,
    });
  };

  const cancel = async (): Promise<void> => {
    const runId = activeTask?.runId;
    if (!activeTask || !runId) return;
    // Messages queued for THIS run won't get their run.completed (the run is
    // being stopped) — hand their texts back right away; the engine's late
    // cancelled event finds an empty queue and no-ops.
    returnQueue(activeTask.id);
    // Settle the UI immediately; the engine abort follows and its late events are muted.
    dispatch({ type: "cancelLocal", taskId: activeTask.id });
    await window.wello.cancelRun(runId);
  };

  const respond = async (decision: PermissionDecision): Promise<void> => {
    if (!activeTask || !pending) return;
    dispatch({ type: "resolvePermission", taskId: activeTask.id });
    await window.wello.respondPermission(pending.id, decision);
  };

  const answerQuestion = async (answer: QuestionAnswer): Promise<void> => {
    if (!activeTask || !question) return;
    dispatch({ type: "resolveQuestion", taskId: activeTask.id });
    await window.wello.respondQuestion(answer);
  };

  const answerGithubConnect = async (connected: boolean): Promise<void> => {
    if (!activeTask || !ghConnect) return;
    dispatch({ type: "resolveGithubConnect", taskId: activeTask.id });
    await window.wello.respondGithubConnect(ghConnect.id, connected);
  };

  /** Switch chats while preserving each chat's own composer draft. */
  const switchTo = (id: string | null): void => {
    const from = draftKey(state.activeId);
    const to = draftKey(id);
    if (from !== to) {
      draftsRef.current.set(from, prompt);
      setPrompt(draftsRef.current.get(to) ?? "");
    }
    setSettingsOpen(false);
    dispatch({ type: "setActive", id });
  };

  // The keyboard effect subscribes once; this ref keeps its Ctrl+N bound to the
  // latest switchTo (current activeId/prompt) without re-subscribing per keystroke.
  const switchToRef = useRef(switchTo);
  switchToRef.current = switchTo;
  // The once-bound hotkey handler reads the CURRENT toggle through a ref, and
  // the same no-project guard every other entry point has.
  const togglePanelRef = useRef(togglePanel);
  togglePanelRef.current = togglePanel;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  // Feed the global keyboard handler the current run/overlay state (Esc-to-stop +
  // shortcut hygiene). Cards (pending/question) defer Esc to their own handlers.
  hotkeyStateRef.current = {
    modalOpen: Boolean(
      renaming ||
        deleting ||
        bypassAsk ||
        ultraAsk ||
        paletteOpen ||
        signOutAsk ||
        closeAsk ||
        trustAsk ||
        conflictAsk ||
        rewindAsk,
    ),
    settingsOpen,
  };

  const revertAll = async (): Promise<void> => {
    if (!activePath || !activeTask?.changes) return;
    await window.wello.reviewRevertAll(activePath, activeTask.id).catch(() => undefined);
    await loadChanges(activeTask.id);
    setRefreshKey((k) => k + 1);
    toast({ message: "Все изменения отменены", tone: "success" });
  };

  // Sidebar buckets, as in web Wello: pinned (drag-sortable) + date bands. The
  // chat search filters by title before grouping, so sections without matches
  // disappear together with their captions (groupTasks skips empty bands).
  const taskGroups = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    const src = q ? state.tasks.filter((t) => t.title.toLowerCase().includes(q)) : state.tasks;
    return groupTasks(src);
  }, [state.tasks, filterQuery]);
  const searching = filterQuery.trim().length > 0;

  /** Focus the sidebar chat search (Ctrl+F / the header button), opening the
   *  sidebar first when it's collapsed — an invisible input can't take focus.
   *  flushSync so the input exists to focus in the SAME tick (rAF is frozen in
   *  hidden windows, and a deferred focus can land after the user typed). */
  const focusChatSearch = (): void => {
    flushSync(() => setSidebarOpen(true));
    searchRef.current?.focus();
  };
  const focusChatSearchRef = useRef(focusChatSearch);
  focusChatSearchRef.current = focusChatSearch;

  // Record every screen transition (chat switches, home, hydrate) as history.
  useEffect(() => {
    const cur = state.activeId ?? null;
    if (navSuppress.current) {
      navSuppress.current = false;
      return;
    }
    setNav((p) => {
      if (p.index >= 0 && p.stack[p.index] === cur) return p;
      const stack = [...p.stack.slice(0, p.index + 1), cur];
      return { stack, index: stack.length - 1 };
    });
  }, [state.activeId]);

  const canNavBack = nav.index > 0;
  const canNavForward = nav.index >= 0 && nav.index < nav.stack.length - 1;
  const goNav = (delta: -1 | 1): void => {
    const idx = nav.index + delta;
    if (idx < 0 || idx >= nav.stack.length) return;
    const target = nav.stack[idx] ?? null;
    // A deleted chat's entry resolves to home instead of a ghost screen.
    const exists = target === null || state.tasks.some((t) => t.id === target);
    const resolved = exists ? target : null;
    // Only mute the observer when the jump actually changes activeId — otherwise
    // the flag would survive and swallow the NEXT legitimate transition.
    navSuppress.current = resolved !== (state.activeId ?? null);
    setNav((p) => ({ ...p, index: idx }));
    switchTo(resolved);
  };

  /** One sidebar row; the pinned group injects a drag grip instead of the pin glyph. */
  const renderTaskRow = (t: TaskItem, grip?: ReactNode, dragging?: boolean): ReactNode => (
    <div
      key={t.id}
      data-task-id={t.id}
      className={`recent-item ${state.activeId === t.id ? "active" : ""} ${dragging ? "is-dragging" : ""}`}
    >
      {grip ?? null}
      <button
        className="recent-item__open"
        title={t.title}
        onClick={() => switchTo(t.id)}
      >
        {t.pinned && !grip ? (
          <span className="recent-item__pin" aria-label="закреплено">
            <Icon name="pin" size={12} />
          </span>
        ) : null}
        <span className="recent-item__title">{t.title}</span>
      </button>
      {t.agent.pending || t.agent.question || t.agent.githubConnect ? (
        <span className="recent-item__attn" title="Ждёт вашего ответа" aria-label="ждёт ответа">
          ?
        </span>
      ) : t.agent.running ? (
        <span className="spinner" aria-label="выполняется" />
      ) : null}
      <button
        className="icon-button recent-item__menu"
        title="Действия"
        aria-label={`Действия с «${t.title}»`}
        onClick={(e) => {
          e.stopPropagation();
          setTaskMenuId((v) => (v === t.id ? null : t.id));
        }}
      >
        <Icon name="dots" size={14} />
      </button>
      {taskMenuId === t.id ? (
        <TaskMenu
          pinned={Boolean(t.pinned)}
          onClose={() => setTaskMenuId(null)}
          onPin={() => {
            dispatch({ type: "setPinned", taskId: t.id, pinned: !t.pinned });
            setTaskMenuId(null);
          }}
          onRename={() => {
            setTaskMenuId(null);
            setRenaming({ id: t.id, title: t.title });
          }}
          onDelete={() => {
            setTaskMenuId(null);
            setDeleting({ id: t.id, title: t.title });
          }}
        />
      ) : null}
    </div>
  );

  // Ranked @-mention candidates for the current query (empty when no mention).
  const mentionResults = mention ? rankFileMentions(mentionFiles, mention.query, 10) : [];
  const mentionOpen = mention != null && mentionResults.length > 0;

  // Slash-command registry (App owns the run handlers; the module ranks them).
  const slashCommands = [
    {
      name: "new",
      label: "/new",
      hint: "Новая задача",
      run: () => {
        switchTo(null);
        requestAnimationFrame(() => composerRef.current?.focus());
      },
    },
    { name: "clear", label: "/clear", hint: "Очистить поле ввода", run: () => setPrompt("") },
    {
      name: "terminal",
      label: "/terminal",
      hint: "Открыть терминал",
      run: () =>
        activePath ? openPanel("terminal") : toast({ message: "Сначала откройте проект" }),
    },
    {
      name: "review",
      label: "/review",
      hint: "Проверка изменений",
      run: () =>
        activePath ? openPanel("review") : toast({ message: "Сначала откройте проект" }),
    },
    {
      name: "preview",
      label: "/preview",
      hint: "Превью сайта",
      run: () =>
        activePath ? openPanel("preview") : toast({ message: "Сначала откройте проект" }),
    },
    {
      name: "agents",
      label: "/agents",
      hint: "Панель субагентов",
      run: () =>
        activePath ? openPanel("agents") : toast({ message: "Сначала откройте проект" }),
    },
    { name: "settings", label: "/settings", hint: "Настройки", run: () => openSettings() },
    { name: "commands", label: "/commands", hint: "Палитра команд (Ctrl+K)", run: () => setPaletteOpen(true) },
    {
      name: "init",
      label: "/init",
      hint: "Создать CLAUDE.md — инструкции проекта для агента",
      run: () => {
        if (!activePath) {
          toast({ message: "Сначала откройте проект" });
          return;
        }
        void sendText(
          "Изучи этот репозиторий (структуру папок, README, конфиги, скрипты сборки и тестов) " +
            "и создай в корне файл CLAUDE.md — краткие инструкции для AI-агента: что это за " +
            "проект, как собирать/тестировать/запускать, ключевые папки и архитектура, принятые " +
            "конвенции кода. Пиши сжато и по делу — только факты, которые помогут агенту в " +
            "будущих задачах. Если CLAUDE.md уже существует — обнови его, сохранив полезное.",
        );
      },
    },
    // The trusted project's own .claude/commands: selecting one EXPANDS its
    // template into the composer (we don't rely on the headless engine to
    // interpret a slash), so the user sees the full prompt and sends it.
    ...projectCommands.map((cmd) => ({
      name: cmd.name,
      label: `/${cmd.name}`,
      hint: cmd.argumentHint ? `${cmd.description} · ${cmd.argumentHint}` : cmd.description,
      run: () => {
        const expanded = expandCommandTemplate(cmd.body, commandArgString(prompt));
        setPrompt(expanded);
        requestAnimationFrame(() => {
          composerRef.current?.focus();
          caretToEnd();
        });
      },
    })),
  ];
  const slashResults = slash ? rankSlashCommands(slashCommands, slash.query) : [];
  const slashOpen = slash != null && slashResults.length > 0;
  const runSlash = (cmd: (typeof slashCommands)[number]): void => {
    setSlash(null);
    setPrompt("");
    cmd.run();
  };

  // Command palette (Ctrl+K) actions — App holds the state, the palette is a dumb list.
  const paletteCommands: PaletteCommand[] = [
    {
      id: "new",
      label: "Новая задача",
      hint: "Ctrl+N",
      icon: "compose",
      keywords: "new task новый чат создать",
      run: () => {
        switchTo(null);
        requestAnimationFrame(() => composerRef.current?.focus());
      },
    },
    {
      id: "sidebar",
      label: sidebarOpen ? "Скрыть боковую панель" : "Показать боковую панель",
      hint: "Ctrl+B",
      icon: "sidebar",
      keywords: "sidebar панель",
      run: () => setSidebarOpen((v) => !v),
    },
    {
      id: "terminal",
      label: panels.includes("terminal") ? "Скрыть терминал" : "Открыть терминал",
      hint: "Ctrl+`",
      icon: "terminal",
      keywords: "terminal консоль",
      run: () =>
        activePath ? togglePanel("terminal") : toast({ message: "Сначала откройте проект" }),
    },
    {
      id: "review",
      label: panels.includes("review") ? "Скрыть проверку изменений" : "Проверка изменений",
      icon: "panel",
      keywords: "diff дифф review изменения",
      run: () =>
        activePath ? togglePanel("review") : toast({ message: "Сначала откройте проект" }),
    },
    {
      id: "preview",
      label: panels.includes("preview") ? "Скрыть превью" : "Открыть превью",
      icon: "globe",
      keywords: "preview браузер сайт превью",
      run: () =>
        activePath ? togglePanel("preview") : toast({ message: "Сначала откройте проект" }),
    },
    {
      id: "agents",
      label: panels.includes("agents") ? "Скрыть субагентов" : "Открыть субагентов",
      icon: "subagent",
      keywords: "agents субагенты агенты",
      run: () =>
        activePath ? togglePanel("agents") : toast({ message: "Сначала откройте проект" }),
    },
    {
      id: "settings",
      label: "Настройки",
      hint: "Ctrl+,",
      icon: "gear",
      keywords: "settings preferences",
      run: () => openSettings(),
    },
    {
      id: "folder",
      label: "Выбрать папку проекта",
      icon: "folder",
      keywords: "open folder папка проект",
      run: () => void openFolder(),
    },
    ...MODELS.map((m) => ({
      id: `model:${m.id}`,
      label: `Модель: ${m.label}`,
      hint: m.hint,
      icon: "dot" as IconName,
      keywords: "model модель",
      run: () => selectModel(m.id),
    })),
    ...PERM_MODES.map((m) => ({
      id: `mode:${m.id}`,
      label: `Режим: ${m.label}`,
      hint: m.hint,
      icon: "shieldcheck" as IconName,
      keywords: "mode режим разрешения",
      run: () => selectMode(m.id),
    })),
    {
      id: "topup",
      label: "Тарифы и баланс Wello",
      icon: "wallet",
      keywords: "billing оплата пополнить баланс",
      run: () => void window.wello.openExternal(BILLING_URL),
    },
    {
      id: "disconnect",
      label: "Отключить аккаунт",
      icon: "power",
      keywords: "logout выход отключить",
      run: () => void onDisconnect(),
    },
  ];

  return (
    <div
      className={`shell ${sidebarOpen ? "" : "no-sidebar"} ${panels.length > 0 && activePath ? "has-stack" : ""} ${settingsOpen ? "is-settings" : ""}`}
      // min() keeps a width saved on a big monitor from crushing the editor on a
      // smaller window — the viewport term wins whenever the window shrinks.
      style={{ "--stack-w": `min(${stackWidth}px, calc(100vw - 560px))` } as React.CSSProperties}
    >
      {/* One unified 40px header across the whole window: the frame's caption is
          hidden (main), the bar itself is the window drag region, and the OS
          draws min/max/close as a native overlay at the top-right — so the
          right side holds NOTHING of ours. Double-click-to-maximize and edge
          resize come with the drag region for free. */}
      <header className="titlebar">
        {/* In settings mode the same toggle collapses the settings NAV (the app
            sidebar is hidden with the rest of the chat shell), and history
            navigation is parked until the app is back. */}
        <button
          className="icon-button"
          title={
            (settingsOpen ? settingsNavOpen : sidebarOpen)
              ? "Скрыть боковую панель · Ctrl B"
              : "Показать боковую панель · Ctrl B"
          }
          aria-label={
            (settingsOpen ? settingsNavOpen : sidebarOpen)
              ? "Скрыть боковую панель"
              : "Показать боковую панель"
          }
          aria-pressed={settingsOpen ? settingsNavOpen : sidebarOpen}
          onClick={() =>
            settingsOpen ? setSettingsNavOpen((v) => !v) : setSidebarOpen((v) => !v)
          }
        >
          <Icon name="sidebar" size={15} />
        </button>
        <button
          className="icon-button"
          title="Поиск по чатам · Ctrl F"
          aria-label="Поиск по чатам"
          disabled={settingsOpen}
          onClick={focusChatSearch}
        >
          <Icon name="search" size={15} />
        </button>
        <button
          className="icon-button"
          title="Назад"
          aria-label="Назад"
          disabled={!canNavBack || settingsOpen}
          onClick={() => goNav(-1)}
        >
          <Icon name="back" size={15} />
        </button>
        <button
          className="icon-button"
          title="Вперёд"
          aria-label="Вперёд"
          disabled={!canNavForward || settingsOpen}
          onClick={() => goNav(1)}
        >
          <Icon name="forward" size={15} />
        </button>
      </header>

      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">Wello Code</span>
        </div>
        {/* Top block: the full-width New-task button + the search field, one
            neat 12px-padded group with a hairline before the list. kbd hints
            (Ctrl N on hover, Ctrl F while idle) share one chip style. */}
        <div className="sidebar-top">
          <button
            className={`newtask ${!activeTask && !settingsOpen ? "is-active" : ""}`}
            onClick={() => switchTo(null)}
          >
            <Icon name="compose" size={15} />
            <span className="newtask__label">Новая задача</span>
            <kbd className="kbdchip kbdhint" aria-hidden>
              Ctrl N
            </kbd>
          </button>
          {state.tasks.length > 0 ? (
            <div className="sidebar-search">
              <Icon name="search" size={14} />
              <input
                ref={searchRef}
                className="sidebar-search__input"
                placeholder="Поиск по чатам…"
                value={chatQuery}
                spellCheck={false}
                onChange={(e) => setChatQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setChatQuery("");
                    setFilterQuery("");
                    e.currentTarget.blur();
                  } else if (e.key === "Enter") {
                    // Open the FIRST result. Filter instantly from the field's own
                    // value (the debounced list may still be settling) through the
                    // same grouping, so "first" is exactly the top visible row.
                    e.preventDefault();
                    const q = chatQuery.trim().toLowerCase();
                    const src = q
                      ? state.tasks.filter((t) => t.title.toLowerCase().includes(q))
                      : state.tasks;
                    const first = groupTasks(src)[0]?.tasks[0];
                    if (first) switchTo(first.id);
                  }
                }}
              />
              {chatQuery.length > 0 ? (
                <button
                  className="sidebar-search__x"
                  aria-label="Очистить поиск"
                  onClick={() => {
                    setChatQuery("");
                    setFilterQuery("");
                  }}
                >
                  <Icon name="x" size={11} />
                </button>
              ) : (
                <kbd className="kbdchip kbdhint" aria-hidden>
                  Ctrl F
                </kbd>
              )}
            </div>
          ) : null}
        </div>
        <div className="recent">
          {taskGroups.length === 0 ? (
            <div className="recent-empty">
              <Icon name={searching ? "search" : "compose"} size={18} />
              <p className="recent-empty__title">{searching ? "Ничего не найдено" : "Пока нет задач"}</p>
              {searching ? (
                <button
                  className="button ghost sm"
                  onClick={() => {
                    setChatQuery("");
                    setFilterQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  Сбросить
                </button>
              ) : (
                <p className="recent-empty__hint">История ваших чатов появится здесь.</p>
              )}
            </div>
          ) : (
            taskGroups.map((g) =>
              g.key === "pinned" ? (
                <PinnedList
                  key={g.key}
                  label={g.label}
                  tasks={g.tasks}
                  onReorder={(ids) => dispatch({ type: "reorderPinned", ids })}
                  renderRow={renderTaskRow}
                />
              ) : (
                <div key={g.key} className="recent-group">
                  <p className="recent-caption">{g.label}</p>
                  {g.tasks.map((t) => renderTaskRow(t))}
                </div>
              ),
            )
          )}
        </div>
        <div className="sidebar-footer">
          {(() => {
            // ONE account row (Claude Code style): avatar, identity, live usage,
            // chevron — the dropdown above it carries settings/billing/sign-out.
            // The closed row shows WHO (the display name set in web Settings,
            // falling back to the e-mail's local part, then the plan on old
            // gateways); the open menu header shows the e-mail with the plan
            // chip to its right.
            const leftPct = Math.max(0, Math.round((1 - (subInfo.usedFraction ?? 0)) * 100));
            const planLabel = planLabelOf(subInfo.billing, subInfo.planId);
            const identity =
              subInfo.displayName ?? (subInfo.email ? subInfo.email.split("@")[0] : null);
            const usage =
              subInfo.billing === "subscription"
                ? `${leftPct}%`
                : balanceCents != null
                  ? `$${(balanceCents / 100).toFixed(2)}`
                  : "";
            const low =
              subInfo.billing === "subscription"
                ? leftPct <= 10
                : subInfo.billing === "blocked" ||
                  (balanceCents != null && balanceCents < LOW_BALANCE_CENTS);
            return (
              <div className="acct">
                <button
                  className="acct__row"
                  ref={acctRowRef}
                  aria-haspopup="menu"
                  aria-expanded={acctOpen}
                  title={[identity ?? "", planLabel, usage].filter(Boolean).join(" · ")}
                  onClick={() => setAcctOpen((v) => !v)}
                >
                  <span className="acct__avatar" aria-hidden>
                    <Icon name="user" size={14} />
                  </span>
                  <span className="acct__label">{identity ?? planLabel}</span>
                  {usage ? (
                    <span className={`acct__usage ${low ? "is-low" : ""}`}>{usage}</span>
                  ) : null}
                  <Icon name="chevrondown" size={12} />
                </button>
                {acctOpen ? (
                  <AccountMenu
                    anchorRef={acctRowRef}
                    email={subInfo.email ?? null}
                    plan={planLabel}
                    onClose={() => setAcctOpen(false)}
                    onSettings={() => {
                      setAcctOpen(false);
                      openSettings();
                    }}
                    onDisconnect={() => {
                      setAcctOpen(false);
                      setSignOutAsk(true);
                    }}
                  />
                ) : null}
              </div>
            );
          })()}
        </div>
      </aside>

      {/* The inset work panel: everything right of the sidebar / below the
          titlebar rides ONE rounded surface card (main + the panel dock). In
          settings mode the card chrome moves to .setpage (see app.css). */}
      <div className="workpanel">
      <main
        className={`main ${!settingsOpen && !activeTask ? "is-home" : ""} ${firstTurnScene ? "is-first-turn" : ""}`}
        onDragOver={onDragOver}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {settingsOpen ? (
          <SettingsView
            page={settingsPage}
            onPageChange={setSettingsPage}
            navOpen={settingsNavOpen}
            onBack={closeSettings}
            onDisconnect={() => setSignOutAsk(true)}
            account={{
              email: subInfo.email ?? null,
              name: subInfo.displayName ?? null,
              plan: planLabelOf(subInfo.billing, subInfo.planId),
            }}
          />
        ) : (
          <>
        {/* Chat-column header (Claude Code style): the current chat's title with
            its actions menu on the left, panel toggles on the right — all on one
            line at the top edge of the content. */}
        <div className="chathead">
          {activeTask ? (
            <div className="chattitle">
              <button
                className="chattitle__btn"
                title={activeTask.title}
                aria-haspopup="menu"
                aria-expanded={chatMenuOpen}
                onClick={() => setChatMenuOpen((v) => !v)}
              >
                <span className="chattitle__text">{activeTask.title}</span>
                <Icon name="chevrondown" size={12} />
              </button>
              {chatMenuOpen ? (
                <ChatTitleMenu
                  task={activeTask}
                  trust={wsTrust}
                  onClose={() => setChatMenuOpen(false)}
                  onRename={() => {
                    setChatMenuOpen(false);
                    setRenaming({ id: activeTask.id, title: activeTask.title });
                  }}
                  onPin={() => {
                    setChatMenuOpen(false);
                    dispatch({
                      type: "setPinned",
                      taskId: activeTask.id,
                      pinned: !activeTask.pinned,
                    });
                  }}
                  onDelete={() => {
                    setChatMenuOpen(false);
                    setDeleting({ id: activeTask.id, title: activeTask.title });
                  }}
                  onExport={() => {
                    setChatMenuOpen(false);
                    void exportChat(activeTask);
                  }}
                  onContinueNew={() => {
                    setChatMenuOpen(false);
                    void continueInNewChat(activeTask);
                  }}
                  onToggleTrust={(trusted) => {
                    setChatMenuOpen(false);
                    const path = activeTask.workspacePath;
                    if (!path) return;
                    void window.wello
                      .setWorkspaceTrust(path, trusted)
                      .then(() => refreshWorkspaceMetaRef.current())
                      .then(() =>
                        toast({
                          message: trusted
                            ? "Папка отмечена доверенной"
                            : "Папка переведена в ограниченный режим",
                          tone: "success",
                        }),
                      );
                  }}
                  onClearGrants={() => {
                    setChatMenuOpen(false);
                    const path = activeTask.workspacePath;
                    if (!path) return;
                    void window.wello
                      .clearWorkspaceGrants(path)
                      .then(() => refreshWorkspaceMetaRef.current())
                      .then(() => toast({ message: "Разрешения проекта сброшены", tone: "success" }));
                  }}
                />
              ) : null}
            </div>
          ) : null}
          <span className="chathead__spacer" />
          {waitingTasks.length > 0 ? (
            <button
              className="waitchip"
              title="Фоновая задача ждёт вашего ответа — нажмите, чтобы перейти"
              aria-label={`Задачи ждут ответа: ${waitingTasks.length}`}
              onClick={() => switchTo(waitingTasks[0]!.id)}
            >
              {`Ждут ответа: ${waitingTasks.length}`}
            </button>
          ) : null}
          <div className="chathead__tools" role="toolbar" aria-label="Панели">
            <button
              className={`icon-button ${panels.includes("terminal") ? "is-active" : ""}`}
              title={panels.includes("terminal") ? "Скрыть терминал · Ctrl `" : "Терминал · Ctrl `"}
              aria-label={panels.includes("terminal") ? "Скрыть терминал" : "Открыть терминал"}
              aria-pressed={panels.includes("terminal")}
              disabled={!activePath}
              onClick={() => togglePanel("terminal")}
            >
              <Icon name="terminal" size={15} />
            </button>
            <button
              className={`icon-button ${panels.includes("preview") ? "is-active" : ""}`}
              title={panels.includes("preview") ? "Скрыть превью" : "Превью"}
              aria-label={panels.includes("preview") ? "Скрыть превью" : "Открыть превью"}
              aria-pressed={panels.includes("preview")}
              disabled={!activePath}
              onClick={() => togglePanel("preview")}
            >
              <Icon name="globe" size={15} />
            </button>
            <button
              className={`icon-button ${panels.includes("agents") ? "is-active" : ""}`}
              title={panels.includes("agents") ? "Скрыть субагентов" : "Субагенты"}
              aria-label={panels.includes("agents") ? "Скрыть субагентов" : "Открыть субагентов"}
              aria-pressed={panels.includes("agents")}
              disabled={!activePath}
              onClick={() => togglePanel("agents")}
            >
              <Icon name="subagent" size={15} />
            </button>
            <button
              className={`icon-button ${panels.includes("review") ? "is-active" : ""}`}
              title={panels.includes("review") ? "Скрыть проверку изменений" : "Проверка изменений"}
              aria-label={panels.includes("review") ? "Скрыть проверку изменений" : "Проверка изменений"}
              aria-pressed={panels.includes("review")}
              disabled={!activePath}
              onClick={() => togglePanel("review")}
            >
              <Icon name="panel" size={15} />
            </button>
          </div>
        </div>
        <div className="conversation" ref={scrollRef} onScroll={onConversationScroll}>
          {activeTask ? (
            <Timeline
              task={activeTask}
              onReview={() => openPanel("review")}
              onRevertAll={() => void revertAll()}
              onOpenFile={openFileTab}
              onRetry={() => void retryLast()}
              onTopUp={() => void window.wello.openExternal(BILLING_URL)}
              onEditTurn={startEditTurn}
              onRewindTurn={(itemId, runId) => setRewindAsk({ itemId, runId })}
            />
          ) : null}
          {/* Queued type-ahead: a tight stack of muted bubbles at the thread's
              tail (Claude Code) — the whole stack rides into ONE follow-up when
              the run finishes; hover reveals the ✕ that drops a line. */}
          {activeTask && queue.some((m) => m.taskId === activeTask.id) ? (
            <div className="qstack">
              {queue
                .filter((m) => m.taskId === activeTask.id)
                .map((m) => (
                  <div key={m.id} className="qmsg wello-rise">
                    <button
                      className="qmsg__x"
                      title="Убрать из очереди"
                      aria-label="Убрать сообщение из очереди"
                      onClick={() => removeQueued(m.id)}
                    >
                      <Icon name="x" size={10} />
                    </button>
                    <div className="qmsg__bubble">{m.preview}</div>
                  </div>
                ))}
            </div>
          ) : null}
        </div>

        {/* Empty state: the title sits right above the composer; the pair is
            centered vertically by the flexible space around it (.is-home). */}
        {!activeTask ? (
          <h1 className="hometitle wello-rise" ref={homeTitleRef}>
            Что будем создавать?
          </h1>
        ) : null}

        {activeTask?.agent.plan && activeTask.agent.plan.length > 0 ? (
          <PlanWidget key={activeTask.id} items={activeTask.agent.plan} running={activeRunning} />
        ) : null}

        {ghConnect ? (
          <GithubConnectCard key={ghConnect.id} onRespond={(ok) => void answerGithubConnect(ok)} />
        ) : question ? (
          <QuestionCard key={question.id} request={question} onAnswer={(a) => void answerQuestion(a)} />
        ) : pending ? (
          <PermissionCard request={pending} onRespond={(d) => void respond(d)} />
        ) : null}

        {/* While the agent waits for an ANSWER (clarifying questions / the GitHub
            connect card) the composer hides — the eye lands on the card, and the
            card's own controls (skip/decline) are the honest exits. The draft
            text survives in state and returns with the composer. */}
        <div
          className={"composer" + (question || ghConnect ? " is-quiet" : "")}
          ref={composerElRef}
        >
          {activeTask ? (
            <button
              type="button"
              className={`scrolldown ${farFromBottom ? "is-visible" : ""}`}
              title="К последнему сообщению"
              aria-label="Прокрутить к последнему сообщению"
              aria-hidden={!farFromBottom}
              tabIndex={farFromBottom ? 0 : -1}
              onClick={scrollToLatest}
            >
              <Icon name="chevrondown" size={16} />
            </button>
          ) : null}
          <div className="composer__stack">
            {!activeTask ? (
              <button className="composer__project" onClick={() => void openFolder()}>
                <Icon name="folder" size={15} />
                <span className="composer__project-name">{workspace ? workspace.name : "Выбрать проект"}</span>
                {workspace ? <span className="composer__project-path">{workspace.path}</span> : null}
              </button>
            ) : null}
            <div className={`composer__box ${dragOver && !activeRunning ? "is-dragover" : ""}`}>
              {editing ? (
                <div className="attachnote editnote" role="status">
                  <span className="attachnote__icon" aria-hidden>
                    <Icon name="edit" size={12} />
                  </span>
                  <span className="attachnote__text">
                    <span className="attachnote__title">Правка сообщения</span>
                    <span className="attachnote__sub">
                      Диалог продолжится с этого места — ответы ниже будут заменены
                    </span>
                  </span>
                  <button
                    className="attachnote__x"
                    title="Отменить правку"
                    aria-label="Отменить правку сообщения"
                    onClick={cancelEditTurn}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ) : null}
              {limitNote ? (
                <div className="attachnote" role="status">
                  <span className="attachnote__icon" aria-hidden>
                    <Icon name="attach" size={12} />
                  </span>
                  <span className="attachnote__text">{limitNote}</span>
                  <button
                    className="attachnote__x"
                    title="Скрыть"
                    aria-label="Скрыть уведомление"
                    onClick={() => setLimitNote(null)}
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ) : null}
              {!activeTask && !workspace && prompt.trim() ? (
                <div className="attachnote" role="status">
                  <span className="attachnote__icon" aria-hidden>
                    <Icon name="folder" size={12} />
                  </span>
                  <span className="attachnote__text">
                    Выберите папку проекта — агент будет работать в ней.
                  </span>
                  <button className="button ghost sm attachnote__action" onClick={() => void openFolder()}>
                    Выбрать
                  </button>
                </div>
              ) : null}
              {contextHigh ? (
                <div className="attachnote" role="status">
                  <span className="attachnote__icon" aria-hidden>
                    <Icon name="dot" size={12} />
                  </span>
                  <span className="attachnote__text">
                    Диалог стал длинным — детали ранних шагов могут потеряться. Для новой темы лучше начать
                    новую задачу.
                  </span>
                  <button className="button ghost sm attachnote__action" onClick={() => switchTo(null)}>
                    Новая задача
                  </button>
                </div>
              ) : null}
              {attachments.length > 0 ? (
                <div className="attachrow">
                  {attachments.map((a) => (
                    <span key={a.id} className="attachchip" title={a.kind === "paste" ? undefined : a.path}>
                      {a.kind === "image" ? (
                        <AttachThumb path={a.path} preview={a.preview} />
                      ) : (
                        <Icon
                          name={a.kind === "folder" ? "folder" : a.kind === "paste" ? "copy" : "file"}
                          size={12}
                        />
                      )}
                      <span className="attachchip__label">{attachmentLabel(a)}</span>
                      <button
                        className="attachchip__x"
                        title="Убрать"
                        aria-label={`Убрать ${attachmentLabel(a)}`}
                        onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                      >
                        <Icon name="x" size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              {mentionOpen ? (
                <div className="mentionmenu" role="listbox" aria-label="Файлы проекта">
                  {mentionResults.map((path, i) => (
                    <button
                      key={path}
                      type="button"
                      role="option"
                      aria-selected={i === mentionIndex}
                      className={`mentionmenu__row ${i === mentionIndex ? "is-active" : ""}`}
                      onMouseEnter={() => setMentionIndex(i)}
                      // Keep the textarea focused so onBlur doesn't close the menu first.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void addMentionFile(path)}
                    >
                      <Icon name="file" size={13} />
                      <span className="mentionmenu__name">{baseName(path)}</span>
                      <span className="mentionmenu__path">{path}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {slashOpen ? (
                <div className="mentionmenu" role="listbox" aria-label="Команды">
                  {slashResults.map((c, i) => (
                    <button
                      key={c.name}
                      type="button"
                      role="option"
                      aria-selected={i === slashIndex}
                      className={`mentionmenu__row ${i === slashIndex ? "is-active" : ""}`}
                      onMouseEnter={() => setSlashIndex(i)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => runSlash(c)}
                    >
                      <Icon name="chevron" size={13} />
                      <span className="mentionmenu__name">{c.label}</span>
                      <span className="mentionmenu__path">{c.hint}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <textarea
                ref={composerRef}
                className="composer__input"
                rows={1}
                placeholder={
                  // Queued messages live as bubbles at the thread's tail — the
                  // placeholder stays the ordinary typing hint.
                  activeRunning
                    ? "Печатайте — отправлю после ответа"
                    : activeTask
                      ? "Запросите внесение дополнительных изменений"
                      : workspace
                        ? "Спросите что угодно"
                        : "Сначала выберите папку проекта"
                }
                value={prompt}
                onChange={(e) => {
                  const caret = e.target.selectionStart ?? e.target.value.length;
                  setPrompt(e.target.value);
                  refreshMention(e.target.value, caret);
                  setMentionIndex(0); // new text → a new query → highlight the first row
                  setSlash(detectSlash(e.target.value, caret));
                  setSlashIndex(0);
                }}
                onKeyUp={(e) => {
                  // The @/slash-menu's own navigation keys are handled in onKeyDown —
                  // don't re-detect (which would reset the highlight) on them.
                  if (
                    (mentionOpen || slashOpen) &&
                    ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key)
                  ) {
                    return;
                  }
                  // Arrow/click caret moves (not covered by onChange) re-detect too.
                  const caret = e.currentTarget.selectionStart ?? 0;
                  refreshMention(e.currentTarget.value, caret);
                  setSlash(detectSlash(e.currentTarget.value, caret));
                }}
                onBlur={() => {
                  setMention(null);
                  setSlash(null);
                }}
                onPaste={onPaste}
                onKeyDown={(e) => {
                  // When the slash-menu is open it captures navigation/selection keys.
                  if (slashOpen) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setSlashIndex((n) => (n + 1) % slashResults.length);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setSlashIndex((n) => (n - 1 + slashResults.length) % slashResults.length);
                      return;
                    }
                    if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      runSlash(slashResults[slashIndex] ?? slashResults[0]!);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setSlash(null);
                      return;
                    }
                  }
                  // When the @-menu is open it captures navigation/selection keys.
                  if (mentionOpen) {
                    if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setMentionIndex((n) => (n + 1) % mentionResults.length);
                      return;
                    }
                    if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setMentionIndex((n) => (n - 1 + mentionResults.length) % mentionResults.length);
                      return;
                    }
                    if ((e.key === "Enter" || e.key === "Tab") && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void addMentionFile(mentionResults[mentionIndex] ?? mentionResults[0]!);
                      return;
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setMention(null);
                      return;
                    }
                  }
                  // ↑/↓ prompt history (terminal style). ↑ recalls only from an
                  // empty field or while already walking — editing a multi-line
                  // draft keeps its normal caret movement.
                  if (
                    e.key === "ArrowUp" &&
                    !e.shiftKey &&
                    (prompt === "" || histNavRef.current.index !== null)
                  ) {
                    const step = historyUp(
                      collectPromptHistory(state.tasks, state.activeId),
                      histNavRef.current,
                      prompt,
                    );
                    if (step) {
                      e.preventDefault();
                      histNavRef.current = step.nav;
                      setPrompt(step.text);
                      caretToEnd();
                      return;
                    }
                  }
                  if (e.key === "ArrowDown" && histNavRef.current.index !== null) {
                    const step = historyDown(
                      collectPromptHistory(state.tasks, state.activeId),
                      histNavRef.current,
                    );
                    if (step) {
                      e.preventDefault();
                      histNavRef.current = step.nav;
                      setPrompt(step.text);
                      caretToEnd();
                      return;
                    }
                  }
                  if (e.key === "Escape" && histNavRef.current.index !== null) {
                    e.preventDefault();
                    setPrompt(histNavRef.current.stash);
                    histNavRef.current = { index: null, stash: "" };
                    return;
                  }
                  // Enter sends; Shift+Enter makes a newline; IME composition is left alone.
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer__bar">
                <div className="composer__left">
                  <div className="modelsel plusanchor">
                    <button
                      className="icon-button"
                      title="Прикрепить"
                      aria-label="Прикрепить"
                      disabled={activeRunning}
                      onClick={() => setPlusOpen((v) => !v)}
                    >
                      <Icon name="plus" size={15} />
                    </button>
                    {plusOpen ? (
                      <PlusMenu
                        onClose={() => setPlusOpen(false)}
                        onFiles={() => {
                          setPlusOpen(false);
                          void addFileAttachments();
                        }}
                        onFolder={() => {
                          setPlusOpen(false);
                          void addFolderAttachment();
                        }}
                      />
                    ) : null}
                  </div>
                  <ModeSelect
                    value={mode}
                    onChange={selectMode}
                    disabled={activeRunning}
                    restricted={restricted}
                  />
                  {/* Workspace status chips ride the action row (no extra line
                      under the composer): the git branch — click opens the
                      branch popover (sync + branches); snapshot / no-git go
                      straight to the review panel — plus the situational
                      conflict / project-instructions / restricted chips. */}
                  {activePath && branch ? (
                    <>
                      <BranchChip
                        ref={branchChipRef}
                        info={branch}
                        sync={sync}
                        onClick={() => {
                          if (!branch.isRepo || branch.gitMissing) togglePanel("review");
                          else setBranchPopOpen((v) => !v);
                        }}
                      />
                      {branchPopOpen && branch.isRepo && !branch.gitMissing ? (
                        <BranchPopover
                          anchorRef={branchChipRef}
                          workspacePath={activePath}
                          info={branch}
                          sync={sync}
                          running={activeRunning}
                          model={model}
                          onClose={() => setBranchPopOpen(false)}
                          onOpenReview={() => {
                            setBranchPopOpen(false);
                            openPanel("review");
                          }}
                          onChanged={() => {
                            void refreshBranchRef.current();
                            if (activeTask) void loadChanges(activeTask.id);
                            setRefreshKey((k) => k + 1);
                          }}
                        />
                      ) : null}
                      {conflicts && conflicts.files.length > 0 ? (
                        <button
                          className="wschip wschip--danger"
                          title="В репозитории конфликт слияния — нажмите, чтобы разобраться"
                          onClick={() => setConflictAsk(true)}
                        >
                          <Icon name="gitbranch" size={11} />
                          Конфликт: {conflicts.files.length}
                        </button>
                      ) : null}
                      {instructionsFile ? (
                        <button
                          className={`wschip ${restricted ? "is-muted" : ""}`}
                          title={
                            restricted
                              ? `${instructionsFile} не читается: папка в ограниченном режиме`
                              : `Инструкции проекта — агент подхватывает ${instructionsFile}. Открыть файл`
                          }
                          onClick={() => openFileTab(instructionsFile)}
                        >
                          <Icon name="file" size={11} />
                          {instructionsFile}
                        </button>
                      ) : null}
                      {restricted ? (
                        <button
                          className="wschip wschip--warn"
                          title="Файлы проекта не влияют на агента, режимы без подтверждений выключены. Нажмите, чтобы изменить доверие"
                          onClick={() =>
                            setTrustAsk({
                              path: activePath,
                              name: activeTask?.workspaceName ?? workspace?.name ?? activePath,
                            })
                          }
                        >
                          <Icon name="shieldcheck" size={11} />
                          Ограниченный режим
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <div className="composer__right">
                  {activeTask ? (
                    <ContextRing
                      used={activeTask.agent.contextUsedTokens ?? null}
                      windowTokens={activeTask.agent.contextWindowTokens ?? null}
                      sub={subInfo}
                    />
                  ) : null}
                  <ModelSelect
                    value={model}
                    onChange={selectModel}
                    effort={effort}
                    onEffort={selectEffort}
                    disabled={activeRunning}
                  />
                  {activeRunning ? (
                    <button className="sendbtn sendbtn--stop" title="Остановить" onClick={() => void cancel()}>
                      <Icon name="stop" size={13} />
                    </button>
                  ) : (
                    <button
                      className="sendbtn"
                      title="Отправить (Enter)"
                      aria-label="Отправить"
                      disabled={
                        (activeTask ? !activePath : !workspace) ||
                        (!prompt.trim() && attachments.length === 0)
                      }
                      onClick={() => void send()}
                    >
                      <Icon name="send" size={15} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
          </>
        )}
      </main>

      {panels.length > 0 && activePath ? (
        <PanelDock
          key={activePath}
          panels={panels}
          maximized={maximizedPanel}
          width={stackWidth}
          workspacePath={activePath}
          taskId={activeTask?.id ?? ""}
          refreshKey={refreshKey}
          subagents={activeTask?.agent.subagents ?? []}
          model={model}
          onCaptureScreenshot={attachScreenshot}
          onOpenFile={openFileTab}
          onClosePanel={closePanel}
          onToggleMax={toggleMaxPanel}
          onResize={setStackWidth}
          onResizeEnd={(w) => saveDockPrefs({ w })}
          onRepoChanged={() => {
            void refreshBranchRef.current();
            if (activeTask) void loadChanges(activeTask.id);
          }}
        />
      ) : null}
      </div>

      {renaming ? (
        <RenameModal
          title={renaming.title}
          onCancel={() => setRenaming(null)}
          onSave={(title) => {
            dispatch({ type: "rename", taskId: renaming.id, title });
            setRenaming(null);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmModal
          title="Удалить чат?"
          body={`«${deleting.title}» и вся его история исчезнут из списка. Файлы проекта не пострадают.`}
          confirmLabel="Удалить"
          danger
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            draftsRef.current.delete(draftKey(deleting.id));
            if (state.activeId === deleting.id) setPrompt("");
            // Drop this task's git-less review snapshot (no-op for git repos).
            void window.wello.reviewForget(deleting.id);
            dispatch({ type: "delete", taskId: deleting.id });
            setDeleting(null);
          }}
        />
      ) : null}
      {ultraAsk ? (
        <ConfirmModal
          title="Включить режим Ультра?"
          body={
            "Родной ultracode-режим движка: под каждую задачу агент собирает бригаду " +
            "через оркестрационные сценарии — параллельная разведка, исполнители и " +
            "перепроверка результата отдельными агентами. Качество на сложных задачах " +
            "заметно выше, но расход токенов — в несколько раз больше обычного, баланс " +
            "тает быстрее."
          }
          confirmLabel="Включить Ультра"
          onCancel={() => setUltraAsk(false)}
          onConfirm={() => {
            commitEffort("ultra");
            setUltraAsk(false);
          }}
        />
      ) : null}
      {signOutAsk ? (
        <ConfirmModal
          title="Выйти из аккаунта?"
          body="Понадобится войти заново, чтобы продолжить работу."
          confirmLabel="Выйти"
          danger
          focusCancel
          onCancel={() => setSignOutAsk(false)}
          onConfirm={() => {
            setSignOutAsk(false);
            void onDisconnect();
          }}
        />
      ) : null}
      {trustAsk ? (
        <TrustModal
          name={trustAsk.name}
          path={trustAsk.path}
          onDecide={resolveTrust}
          onDismiss={() => {
            setTrustAsk(null);
            afterTrustRef.current = null;
          }}
        />
      ) : null}
      {rewindAsk ? (
        <ConfirmModal
          title="Вернуться к этому ходу?"
          body={
            "Файлы проекта вернутся к состоянию перед этим ходом — всё, что агент изменил " +
            "в этом и последующих ходах, будет отменено. Диалог обрежется до этого места, " +
            "текст хода вернётся в поле ввода. Действие необратимо."
          }
          confirmLabel="Вернуться к ходу"
          danger
          focusCancel
          onCancel={() => setRewindAsk(null)}
          onConfirm={() => {
            const target = rewindAsk;
            setRewindAsk(null);
            void rewindToTurn(target.itemId, target.runId);
          }}
        />
      ) : null}
      {conflictAsk && conflicts && conflicts.files.length > 0 ? (
        <ConflictModal
          conflicts={conflicts}
          busy={activeRunning}
          onAskAgent={() => {
            setConflictAsk(false);
            const op = conflicts.operation ?? "merge";
            const files = conflicts.files.map((f) => `- ${f}`).join("\n");
            void sendText(
              `В репозитории незавершённая операция ${op} с конфликтами. Конфликтные файлы:\n` +
                `${files}\n\nРазреши конфликты: изучи обе стороны изменений в каждом файле и ` +
                "объедини их так, чтобы сохранить намерения обеих сторон; убери конфликт-маркеры " +
                "(<<<<<<<, =======, >>>>>>>). После разрешения добавь файлы в индекс (git add) и " +
                `заверши операцию (git ${op} --continue), либо скажи, что осталось сделать вручную.`,
            );
          }}
          onAbort={() => {
            setConflictAsk(false);
            if (!activePath) return;
            void window.wello.gitAbortConflict(activePath).then((res) => {
              if (res.ok) toast({ message: "Операция прервана", tone: "success" });
              else toast({ message: res.stderr || "Не удалось прервать", tone: "danger" });
              void refreshBranchRef.current();
              if (activeTask) void loadChanges(activeTask.id);
              setRefreshKey((k) => k + 1);
            });
          }}
          onClose={() => setConflictAsk(false)}
        />
      ) : null}
      {closeAsk ? (
        <Modal title="Идёт генерация" onClose={() => setCloseAsk(false)}>
          <p className="modal__body">
            Агент ещё работает. Свернуть окно, чтобы дать ему договорить, — ответ сохранится, и
            вы вернётесь к готовому результату. Если выйти сейчас, незавершённый ответ пропадёт
            (изменения в файлах останутся как есть).
          </p>
          <div className="modal__actions">
            <button
              className="button sm danger-solid"
              onClick={() => {
                setCloseAsk(false);
                void window.wello.confirmClose();
              }}
            >
              Прервать и выйти
            </button>
            <span className="modal__actions-spacer" />
            <ModalCancel fallback={() => setCloseAsk(false)}>Отмена</ModalCancel>
            <button
              className="button sm primary"
              autoFocus
              onClick={() => {
                setCloseAsk(false);
                void window.wello.minimizeWindow();
              }}
            >
              Свернуть, дать доработать
            </button>
          </div>
        </Modal>
      ) : null}
      {bypassAsk ? (
        <ConfirmModal
          title="Включить полный доступ?"
          body={
            "В режиме «Полный доступ» агент выполняет команды, меняет и удаляет файлы, " +
            "выходит в сеть — без единого подтверждения. Ошибка модели или вредоносная " +
            "инструкция в файлах проекта смогут навредить без вашего ведома. Включайте " +
            "только для доверенных задач в изолированных проектах."
          }
          confirmLabel="Понимаю, включить"
          danger
          onCancel={() => setBypassAsk(false)}
          onConfirm={() => {
            commitMode("bypass");
            setBypassAsk(false);
          }}
        />
      ) : null}
      {!gateClosed &&
      subInfo.planActive === false &&
      (subInfo.billing === "blocked" ||
        (subInfo.billing === "payg" && localStorage.getItem(PAYG_ACK_LS) !== "1")) ? (
        <SubGateModal
          billing={subInfo.billing}
          balanceCents={balanceCents}
          onClose={() => setGateClosed(true)}
          onAckPayg={() => {
            localStorage.setItem(PAYG_ACK_LS, "1");
            setGateClosed(true);
          }}
        />
      ) : null}
      {paletteOpen ? (
        <CommandPalette
          commands={paletteCommands}
          tasks={state.tasks.map((t) => ({ id: t.id, title: t.title }))}
          onSwitchTask={switchTo}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** Row action menu for a task in the sidebar. */
function TaskMenu({
  pinned,
  onClose,
  onPin,
  onRename,
  onDelete,
}: {
  pinned: boolean;
  onClose: () => void;
  onPin: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [up, setUp] = useState(false);
  useDropUp(true, onClose, rootRef);
  // Flip upward when opening downward would spill past the sidebar's scroll box
  // (lower rows would otherwise be clipped and the items become unreachable).
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const scroller = el.closest(".recent");
    const bound = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
    if (el.getBoundingClientRect().bottom > bound - 4) setUp(true);
  }, []);
  return (
    <div className={`taskmenu ${up ? "taskmenu--up" : ""}`} ref={rootRef} role="menu">
      <button className="taskmenu__item" role="menuitem" onClick={onPin}>
        <Icon name="pin" size={13} />
        {pinned ? "Открепить" : "Закрепить"}
      </button>
      <button className="taskmenu__item" role="menuitem" onClick={onRename}>
        <Icon name="edit" size={13} />
        Переименовать
      </button>
      <button className="taskmenu__item is-danger" role="menuitem" onClick={onDelete}>
        <Icon name="trash" size={13} />
        Удалить
      </button>
    </div>
  );
}

/**
 * The current chat's dropdown under its title in the chat-column header:
 * rename/pin/delete plus the project row — folder name over the full path,
 * click reveals the folder in the OS file manager, the side button copies it.
 */
function ChatTitleMenu({
  task,
  trust,
  onClose,
  onRename,
  onPin,
  onDelete,
  onExport,
  onContinueNew,
  onToggleTrust,
  onClearGrants,
}: {
  task: TaskItem;
  trust: WorkspaceTrust | null;
  onClose: () => void;
  onRename: () => void;
  onPin: () => void;
  onDelete: () => void;
  onExport: () => void;
  onContinueNew: () => void;
  onToggleTrust: (trusted: boolean) => void;
  onClearGrants: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useDropUp(true, onClose, rootRef);
  const path = task.workspacePath ?? null;
  // Actions on the conversation's content only make sense once it has one.
  const hasContent = task.agent.items.some((i) => i.kind === "user" || i.kind === "message");
  return (
    <div className="taskmenu chatmenu" ref={rootRef} role="menu">
      <button className="taskmenu__item" role="menuitem" onClick={onRename}>
        <Icon name="edit" size={13} />
        Переименовать
      </button>
      <button className="taskmenu__item" role="menuitem" onClick={onPin}>
        <Icon name="pin" size={13} />
        {task.pinned ? "Открепить" : "Закрепить"}
      </button>
      {hasContent ? (
        <>
          <button className="taskmenu__item" role="menuitem" onClick={onContinueNew}>
            <Icon name="compose" size={13} />
            Продолжить в новом чате
          </button>
          <button className="taskmenu__item" role="menuitem" onClick={onExport}>
            <Icon name="file" size={13} />
            Экспорт в Markdown
          </button>
        </>
      ) : null}
      <button className="taskmenu__item is-danger" role="menuitem" onClick={onDelete}>
        <Icon name="trash" size={13} />
        Удалить
      </button>
      {path ? (
        <>
          <div className="taskmenu__sep" role="separator" />
          <div className="chatmenu__project">
            <button
              className="taskmenu__item chatmenu__folder"
              role="menuitem"
              title="Открыть папку в проводнике"
              onClick={() => {
                void window.wello.revealWorkspace(path);
                onClose();
              }}
            >
              <Icon name="folder" size={13} />
              <span className="chatmenu__meta">
                <span className="chatmenu__name">{task.workspaceName ?? path}</span>
                <span className="chatmenu__path">{path}</span>
              </span>
            </button>
            <button
              className="icon-button"
              title="Скопировать путь"
              aria-label="Скопировать путь проекта"
              onClick={() => {
                void window.wello.copyText(path).then(
                  () => toast({ message: "Путь скопирован", tone: "success" }),
                  () => toast({ message: "Не удалось скопировать", tone: "danger" }),
                );
                onClose();
              }}
            >
              <Icon name="copy" size={13} />
            </button>
          </div>
          {trust?.decided ? (
            <button
              className="taskmenu__item"
              role="menuitemcheckbox"
              aria-checked={trust.trusted}
              title={
                trust.trusted
                  ? "Агент читает инструкции проекта, разрешения можно запоминать"
                  : "Файлы проекта не влияют на агента, каждый шаг подтверждается"
              }
              onClick={() => onToggleTrust(!trust.trusted)}
            >
              <Icon name="shieldcheck" size={13} />
              Доверять папке
              {trust.trusted ? <Icon name="check" size={13} /> : null}
            </button>
          ) : null}
          {trust?.trusted && trust.grantedCaps.length > 0 ? (
            <button
              className="taskmenu__item"
              role="menuitem"
              title="Забыть все «Разрешить для проекта» — агент снова будет спрашивать"
              onClick={onClearGrants}
            >
              <Icon name="x" size={13} />
              Сбросить разрешения ({trust.grantedCaps.length})
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** The account menu's fixed width (also used by the clamping math). */
const ACCT_MENU_W = 260;

/**
 * The sidebar-footer account menu (opens upward, Claude Code style): plan
 * header, live usage, settings (with its hotkey hint), the app version and
 * sign-out. Rendered through a PORTAL into the app's root layer — inside the
 * sidebar it would be clipped by the sidebar's overflow (it is wider than the
 * rail). Fixed-positioned off the account row: up with an 8px gap, left edges
 * aligned, clamped ≥8px from the window edges, flipped below when there's no
 * room above. Fully keyboard-driven: arrows walk the items, Enter activates,
 * Esc / outside click close (useDropUp); any scroll or a window resize closes
 * it so it can never hang detached from its anchor.
 */
function AccountMenu({
  anchorRef,
  email,
  plan,
  onClose,
  onSettings,
  onDisconnect,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  /** Account e-mail from /code/v1/access (null against pre-identity gateways). */
  email?: string | null;
  plan: string;
  onClose: () => void;
  onSettings: () => void;
  onDisconnect: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  useDropUp(true, onClose, rootRef);

  // Anchor math (before paint): left edge on the row's left edge, clamped to
  // the window with an 8px margin; upward by default, downward when the menu
  // would poke past the top.
  useLayoutEffect(() => {
    const a = anchorRef.current;
    if (!a) return;
    const r = a.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - ACCT_MENU_W - 8));
    const menuH = rootRef.current?.offsetHeight ?? 0;
    if (r.top - 8 - menuH < 8 && r.bottom + 8 + menuH <= window.innerHeight - 8) {
      setPos({ left, top: r.bottom + 8 });
    } else {
      setPos({ left, bottom: window.innerHeight - r.top + 8 });
    }
  }, [anchorRef]);

  // The fixed menu knows nothing about layout changes around its anchor —
  // close on any scroll (capture catches inner scrollers) and on resize.
  useEffect(() => {
    const close = (): void => onClose();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [onClose]);

  // Focus the first item on open; arrows cycle through the enabled items.
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, []);
  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "ArrowDown"
        ? items[(idx + 1) % items.length]
        : items[(idx - 1 + items.length) % items.length];
    next?.focus();
  };
  return createPortal(
    <div
      className="taskmenu acctmenu"
      ref={rootRef}
      role="menu"
      style={
        pos
          ? { left: pos.left, top: pos.top, bottom: pos.bottom, visibility: "visible" }
          : { visibility: "hidden" } /* first frame: measured, not yet placed */
      }
      onKeyDown={onMenuKey}
    >
      {/* Header: the account e-mail with the plan chip pinned to its right
          (plan-only against pre-identity gateways). */}
      <div className="acctmenu__meta">
        {email ? (
          <>
            <span className="acctmenu__email" title={email}>
              {email}
            </span>
            <span className="acctmenu__plan">{plan}</span>
          </>
        ) : (
          <span className="acctmenu__email">{plan}</span>
        )}
      </div>
      <div className="taskmenu__sep" role="separator" />
      <button className="taskmenu__item" role="menuitem" onClick={onSettings}>
        <Icon name="gear" size={13} />
        <span className="acctmenu__label">Настройки</span>
        <kbd className="kbdchip acctmenu__kbd" aria-hidden>
          Ctrl ,
        </kbd>
      </button>
      <div className="taskmenu__sep" role="separator" />
      <button className="taskmenu__item is-danger" role="menuitem" onClick={onDisconnect}>
        <Icon name="power" size={13} />
        <span className="acctmenu__label">Выйти из аккаунта</span>
      </button>
    </div>,
    document.body,
  );
}

/**
 * The pinned block of the sidebar: rows reorder by dragging the six-dot grip
 * (as in web Wello). Live-commit: crossing another row's midpoint reorders at
 * once, so the list is always the real order — no ghost, no drop animation.
 */
function PinnedList({
  label,
  tasks,
  onReorder,
  renderRow,
}: {
  label: string;
  tasks: TaskItem[];
  onReorder: (ids: string[]) => void;
  renderRow: (t: TaskItem, grip?: ReactNode, dragging?: boolean) => ReactNode;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const ids = tasks.map((t) => t.id);

  const begin = (e: React.PointerEvent<HTMLSpanElement>, id: string): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragId(id);
  };
  const move = (e: React.PointerEvent<HTMLSpanElement>, id: string): void => {
    if (dragId !== id || !listRef.current) return;
    // Target slot = how many OTHER rows the pointer is below (by their midpoints).
    const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-task-id]"));
    let to = 0;
    for (const row of rows) {
      if (row.dataset.taskId === id) continue;
      const r = row.getBoundingClientRect();
      if (e.clientY > r.top + r.height / 2) to += 1;
    }
    if (to !== ids.indexOf(id)) {
      const next = ids.filter((x) => x !== id);
      next.splice(to, 0, id);
      onReorder(next);
    }
  };
  const end = (): void => setDragId(null);

  return (
    <div ref={listRef} className="recent-group" aria-label={label}>
      <p className="recent-caption">{label}</p>
      {tasks.map((t) =>
        renderRow(
          t,
          <span
            key={`grip-${t.id}`}
            className="recent-item__grip"
            role="button"
            title="Перетащите, чтобы изменить порядок"
            aria-label={`Переместить «${t.title}»`}
            onPointerDown={(e) => begin(e, t.id)}
            onPointerMove={(e) => move(e, t.id)}
            onPointerUp={end}
            onPointerCancel={end}
          >
            <Icon name="grip" size={13} />
          </span>,
          dragId === t.id,
        ),
      )}
    </div>
  );
}

/** The composer "+" menu: attach files or a folder. */
function PlusMenu({
  onClose,
  onFiles,
  onFolder,
}: {
  onClose: () => void;
  onFiles: () => void;
  onFolder: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useDropUp(true, onClose, rootRef);
  return (
    <div className="modelsel__menu modelsel__menu--left plusmenu" ref={rootRef} role="menu">
      <p className="modelsel__caption">Добавить</p>
      <button className="modelsel__item" role="menuitem" onClick={onFiles}>
        <span className="plusmenu__icon">
          <Icon name="attach" size={14} />
        </span>
        <span className="modelsel__item-body">
          <span className="modelsel__item-label">Файлы</span>
          <span className="modelsel__item-hint">Код, документы, изображения</span>
        </span>
      </button>
      <button className="modelsel__item" role="menuitem" onClick={onFolder}>
        <span className="plusmenu__icon">
          <Icon name="folder" size={14} />
        </span>
        <span className="modelsel__item-body">
          <span className="modelsel__item-label">Папку</span>
          <span className="modelsel__item-hint">Каталог целиком, как контекст</span>
        </span>
      </button>
    </div>
  );
}

/* The shared Modal/ModalCancel shell (and its dismiss context) moved to
   Modal.tsx — stage 3: Settings and the branch popover open dialogs too. */

function RenameModal({
  title,
  onSave,
  onCancel,
}: {
  title: string;
  onSave: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  const ok = value.trim().length > 0;
  return (
    <Modal title="Переименовать чат" onClose={onCancel}>
      <input
        className="input"
        value={value}
        autoFocus
        onFocus={(e) => e.target.select()}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && ok) onSave(value.trim());
        }}
      />
      <div className="modal__actions">
        <ModalCancel fallback={onCancel}>Отмена</ModalCancel>
        <button className="button primary sm" disabled={!ok} onClick={() => onSave(value.trim())}>
          Сохранить
        </button>
      </div>
    </Modal>
  );
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  danger,
  focusCancel,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  /** Land the default focus on «Отмена» (e.g. sign-out: Enter must not sign out). */
  focusCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="modal__body">{body}</p>
      <div className="modal__actions">
        <ModalCancel fallback={onCancel} autoFocus={focusCancel}>
          Отмена
        </ModalCancel>
        <button
          className={`button sm ${danger ? "danger-solid" : "primary"}`}
          autoFocus={!focusCancel}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/**
 * The agent's live plan (its TodoWrite list) as a compact checklist above the
 * composer — the same visual anchor Claude Code gives a run's progress. Every
 * TodoWrite carries the full list, so this just renders the latest snapshot.
 * Collapses to a one-line bar; auto-collapses once the run finished with every
 * item completed (the plan is history at that point, not guidance).
 */
function PlanWidget({ items, running }: { items: PlanTodo[]; running: boolean }) {
  const done = items.filter((i) => i.status === "completed").length;
  const allDone = done === items.length;
  const [collapsed, setCollapsed] = useState(() => !running && allDone);
  const prevRunningRef = useRef(running);
  useEffect(() => {
    // Auto-collapse exactly on the run's finish (not on user re-expand later).
    if (prevRunningRef.current && !running && allDone) setCollapsed(true);
    prevRunningRef.current = running;
  }, [running, allDone]);

  return (
    <section className={`planw ${collapsed ? "is-collapsed" : ""}`} aria-label="План агента">
      <button
        className="planw__bar"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed((v) => !v)}
      >
        <Icon name="check" size={12} />
        <span className="planw__title">План</span>
        <span className="planw__count">
          {done}/{items.length}
        </span>
        <span className="planw__spacer" />
        {/* The arrow points where the list will GO: down to unfold below the
            bar, up to fold back into it (the rotated side-chevron read wrong). */}
        <span className="planw__chev" aria-hidden>
          <Icon name={collapsed ? "chevrondown" : "chevronup"} size={11} />
        </span>
      </button>
      {!collapsed ? (
        <ul className="planw__list">
          {items.map((item, i) => (
            <li key={i} className={`planw__item is-${item.status}`}>
              <span className="planw__mark" aria-hidden>
                {item.status === "completed" ? (
                  <Icon name="check" size={11} />
                ) : item.status === "in_progress" ? (
                  <span className="planw__spin" />
                ) : null}
              </span>
              <span className="planw__text">{item.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** RU labels for the in-flight git operation on the conflict modal. */
const CONFLICT_OP_LABEL: Record<string, string> = {
  merge: "слияние (merge)",
  rebase: "перебазирование (rebase)",
  "cherry-pick": "cherry-pick",
  revert: "revert",
};

/**
 * The merge-conflict helper: lists the unmerged files and offers the two honest
 * exits — hand the resolution to the agent as a regular turn, or abort the
 * whole operation. Everything else (manual resolution) stays possible outside.
 */
function ConflictModal({
  conflicts,
  busy,
  onAskAgent,
  onAbort,
  onClose,
}: {
  conflicts: GitConflictInfo;
  /** An agent run is in flight — resolving via agent must wait for it. */
  busy: boolean;
  onAskAgent: () => void;
  onAbort: () => void;
  onClose: () => void;
}) {
  const shown = conflicts.files.slice(0, 8);
  const rest = conflicts.files.length - shown.length;
  const opLabel = CONFLICT_OP_LABEL[conflicts.operation ?? "merge"] ?? conflicts.operation;
  return (
    <Modal title="Конфликт слияния" onClose={onClose}>
      <p className="modal__body">
        Не завершено {opLabel}: git не смог объединить изменения автоматически. Конфликтные файлы:
      </p>
      <ul className="conflict__files">
        {shown.map((f) => (
          <li key={f}>
            <code>{f}</code>
          </li>
        ))}
        {rest > 0 ? <li className="conflict__more">…и ещё {rest}</li> : null}
      </ul>
      <div className="modal__actions">
        <button className="button ghost sm" onClick={onAbort}>
          Прервать операцию
        </button>
        <span className="modal__actions-spacer" />
        <ModalCancel fallback={onClose}>Позже</ModalCancel>
        <button
          className="button primary sm"
          autoFocus
          disabled={busy}
          title={busy ? "Дождитесь конца текущего хода" : undefined}
          onClick={onAskAgent}
        >
          Попросить агента разрешить
        </button>
      </div>
    </Modal>
  );
}

/**
 * The workspace-trust question (VS Code style). Trusted folders get the full
 * project experience: the agent reads CLAUDE.md/.claude settings, «Разрешить
 * для проекта» grants persist, Авто/Полный доступ work. Restricted folders run
 * isolated and only in asking modes. Dismissing (Esc / ×) defers the decision —
 * the send gate re-asks before the first run.
 */
function TrustModal({
  name,
  path,
  onDecide,
  onDismiss,
}: {
  name: string;
  path: string;
  onDecide: (trusted: boolean) => void;
  onDismiss: () => void;
}) {
  return (
    <Modal title="Доверять этой папке?" onClose={onDismiss}>
      <div className="trust__target" title={path}>
        <Icon name="folder" size={14} />
        <span className="trust__name">{name}</span>
        <span className="trust__path">{path}</span>
      </div>
      <p className="modal__body">
        Агент выполняет команды и читает инструкции из файлов проекта (CLAUDE.md, настройки
        .claude). Вредоносный репозиторий может через них попытаться управлять агентом —
        доверяйте только папкам, происхождение которых знаете.
      </p>
      <ul className="trust__diff">
        <li>
          <strong>Доверенная</strong> — агент подхватывает инструкции проекта, разрешения можно
          запоминать, доступны режимы «Авто» и «Полный доступ».
        </li>
        <li>
          <strong>Ограниченный режим</strong> — файлы проекта не влияют на агента, каждый шаг
          подтверждается вручную. Изменить выбор можно в меню чата.
        </li>
      </ul>
      <div className="modal__actions">
        <button className="button ghost sm" onClick={() => onDecide(false)}>
          Ограниченный режим
        </button>
        <button className="button primary sm" autoFocus onClick={() => onDecide(true)}>
          Доверяю папке
        </button>
      </div>
    </Modal>
  );
}

/** "Continue with PAYG" acknowledgement — shown once per install, then remembered. */
const PAYG_ACK_LS = "wello-code-payg-ack";

/**
 * The subscription gate: Wello Code ships as a Pro+ perk. Without an active plan
 * the user either explicitly opts into pay-as-you-go (billing === "payg": the
 * balance funds every turn at usage rates) or hits the paywall (billing ===
 * "blocked": no plan AND nothing to pay with). Closing the blocked variant is
 * allowed — the server rejects unfunded turns anyway with a clear 402.
 */
function SubGateModal({
  billing,
  balanceCents,
  onClose,
  onAckPayg,
}: {
  billing: Connection["billing"];
  balanceCents: number | null;
  onClose: () => void;
  onAckPayg: () => void;
}) {
  const blocked = billing === "blocked";
  const balance = balanceCents != null ? `$${(balanceCents / 100).toFixed(2)}` : null;
  return (
    <Modal title="Wello Code — часть подписки" onClose={onClose}>
      <p className="modal__body">
        {blocked
          ? "Wello Code входит в подписку Pro и выше. На аккаунте нет ни подписки, ни средств " +
            "на балансе — оформите подписку или пополните баланс, чтобы работать по факту (PAYG)."
          : "Wello Code входит в подписку Pro и выше. Подписки на аккаунте нет, поэтому работа " +
            `будет оплачиваться по факту (PAYG) с баланса${balance ? ` — сейчас на нём ${balance}` : ""}. ` +
            "Подписка выгоднее при регулярной работе."}
      </p>
      <div className="modal__actions">
        {blocked ? (
          <button
            className="button ghost sm"
            onClick={() => void window.wello.openExternal(`${BILLING_URL}#topup`)}
          >
            Пополнить баланс
          </button>
        ) : (
          <button className="button ghost sm" onClick={onAckPayg}>
            Продолжить по PAYG
          </button>
        )}
        <button
          className="button primary sm"
          autoFocus
          onClick={() => void window.wello.openExternal(`${BILLING_URL}#plans`)}
        >
          Оформить подписку
        </button>
      </div>
    </Modal>
  );
}

function Timeline({
  task,
  onReview,
  onRevertAll,
  onOpenFile,
  onRetry,
  onTopUp,
  onEditTurn,
  onRewindTurn,
}: {
  task: TaskItem;
  onReview: () => void;
  onRevertAll: () => void;
  onOpenFile: (path: string) => void;
  onRetry: () => void;
  onTopUp: () => void;
  /** Start editing a user turn (forks the conversation at that point). */
  onEditTurn: (itemId: string) => void;
  /** Rewind the project + conversation to a user turn (restores files). */
  onRewindTurn: (itemId: string, runId: string) => void;
}) {
  const { items, running, elapsedMs, startedAt } = task.agent;
  // The open image + its message siblings, so the lightbox can page between them.
  const [lightbox, setLightbox] = useState<{ paths: string[]; index: number } | null>(null);
  const openImage = (paths: string[], index: number): void => setLightbox({ paths, index });
  const lastUserIdx = items.reduce((acc, it, idx) => (it.kind === "user" ? idx : acc), -1);
  const toolsAfterLastUser = items.some((it, idx) => idx > lastUserIdx && it.kind === "tool");
  const nodes: ReactNode[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i]!;
    if (it.kind === "tool") {
      const group: ToolItem[] = [];
      while (i < items.length && items[i]!.kind === "tool") {
        group.push(items[i] as ToolItem);
        i += 1;
      }
      const isTrailing = i === items.length;
      nodes.push(
        <Activity
          key={group[0]!.id}
          tools={group}
          running={running && isTrailing}
          startedAt={startedAt}
          elapsedMs={isTrailing ? elapsedMs : null}
        />,
      );
    } else {
      // A user turn is editable once nothing runs; file/paste attachments can't
      // be reconstructed from the persisted metadata, so those turns stay fixed.
      const editable =
        it.kind === "user" &&
        !running &&
        Boolean(it.text.trim()) &&
        (it.attachments?.length ?? 0) === 0;
      // Rewind needs the turn's checkpoint label (its run id).
      const rewindId = it.kind === "user" && !running ? it.runId : undefined;
      nodes.push(
        <Item
          key={it.id}
          item={it}
          onOpenImage={openImage}
          onOpenFile={onOpenFile}
          onEdit={editable ? () => onEditTurn(it.id) : undefined}
          onRewind={rewindId ? () => onRewindTurn(it.id, rewindId) : undefined}
        />,
      );
      // The finished turn ran with no tool steps: show its duration right after the ask.
      if (i === lastUserIdx && !running && !toolsAfterLastUser && elapsedMs != null) {
        nodes.push(
          <div key={`turn-${it.id}`} className="turnline">
            <span className="turnline__label">Работал на протяжении {fmtElapsed(elapsedMs)}</span>
            <span className="turnline__rule" />
          </div>,
        );
      }
      i += 1;
    }
  }
  const trailingTool = items.length > 0 && items[items.length - 1]!.kind === "tool";
  const showChanges = !running && task.changes && task.changes.files.length > 0;
  const lastItem = items[items.length - 1];
  // A terminal note that offers a retry: a real failure (danger) or a user Stop
  // (cancelled). Both let the user re-run the last turn.
  const lastIsInterrupt =
    lastItem?.kind === "note" && (lastItem.tone === "danger" || lastItem.tone === "cancelled");
  const failure = task.agent.lastFailure ?? null;
  // Out of balance: retrying just fails again — offer a top-up instead of retry.
  const showTopUp = !running && lastIsInterrupt && failure?.code === "insufficient_balance";
  const showRetry = !running && lastIsInterrupt && (failure?.retryable ?? true);
  return (
    <div className="thread">
      {nodes}
      {running && !trailingTool ? (
        <div className="turnline" aria-live="polite">
          <span className="runstatus__label">{describeCurrentAction(items, running) ?? "Думает…"}</span>
          <span className="turnline__label runstatus__time">
            {" · "}
            <LiveElapsed startedAt={startedAt} />
          </span>
          <span className="turnline__rule" />
        </div>
      ) : null}
      {!running && (showRetry || showTopUp) ? (
        <AnswerActions
          onRetry={showRetry ? onRetry : undefined}
          onTopUp={showTopUp ? onTopUp : undefined}
        />
      ) : null}
      {showChanges ? (
        <ChangeSetCard
          changes={task.changes!}
          onReview={onReview}
          onRevertAll={onRevertAll}
          onOpenFile={onOpenFile}
        />
      ) : null}
      {lightbox ? (
        <Lightbox
          paths={lightbox.paths}
          index={lightbox.index}
          onIndex={(index) => setLightbox((v) => (v ? { ...v, index } : v))}
          onClose={() => setLightbox(null)}
        />
      ) : null}
    </div>
  );
}

/** A once-a-second ticking elapsed label for the running turn. */
function LiveElapsed({ startedAt }: { startedAt: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  const base = useRef(startedAt ? Date.parse(startedAt) : Date.now());
  useEffect(() => {
    if (startedAt) base.current = Date.parse(startedAt);
  }, [startedAt]);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return <>{fmtElapsed(now - base.current)}</>;
}

function Activity({
  tools,
  running,
  startedAt,
  elapsedMs,
}: {
  tools: ToolItem[];
  running: boolean;
  startedAt: string | null;
  elapsedMs: number | null;
}) {
  const [open, setOpen] = useState(running);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (running) setOpen(true);
    else if (wasRunning.current) setOpen(false);
    wasRunning.current = running;
  }, [running]);

  const runningTool = running ? [...tools].reverse().find((t) => t.status === "running") : undefined;
  const label = running ? (
    <>
      <span className="runstatus__label">
        {runningTool ? toolActionLabel(runningTool.icon) : "Думает…"}
      </span>
      {" · "}
      <LiveElapsed startedAt={startedAt} />
    </>
  ) : elapsedMs != null ? (
    <>Работал на протяжении {fmtElapsed(elapsedMs)}</>
  ) : (
    <>
      {tools.length} {plural(tools.length, "шаг", "шага", "шагов")}
    </>
  );

  return (
    <details className="activity" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="activity__summary">
        <span className="turnline__label">{label}</span>
        <span className="activity__chev">
          <Icon name="chevron" size={12} />
        </span>
        <span className="turnline__rule" />
      </summary>
      <div className="activity__tools">
        {tools.map((t) => (
          <div key={t.id} className={`tool tool--${t.status}`}>
            <span className="tool__icon">
              <Icon name={t.icon} size={13} />
            </span>
            <span className="tool__summary">{t.summary}</span>
            {t.status === "recovered" ? (
              <span className="tool__status tool__status--soft">повтор</span>
            ) : t.status === "failed" ? (
              <span className="tool__status">ошибка</span>
            ) : null}
          </div>
        ))}
      </div>
    </details>
  );
}

function Item({
  item,
  onOpenImage,
  onOpenFile,
  onEdit,
  onRewind,
}: {
  item: TimelineItem;
  onOpenImage: (paths: string[], index: number) => void;
  onOpenFile: (path: string) => void;
  /** Present on editable user turns (no run in flight, no file attachments). */
  onEdit?: () => void;
  /** Present on user turns with a checkpoint (rewind restores files). */
  onRewind?: () => void;
}) {
  switch (item.kind) {
    case "user":
      return (
        <UserBubble
          text={item.text}
          images={item.images}
          attachments={item.attachments}
          onOpenImage={onOpenImage}
          onEdit={onEdit}
          onRewind={onRewind}
        />
      );
    case "message":
      return <AssistantMessage text={item.text} onOpenFile={onOpenFile} />;
    case "plan":
      return (
        <div className="plan">
          <div className="plan__summary">{item.summary}</div>
          <ol className="plan__steps">
            {item.steps.map((s) => (
              <li key={s.id}>{s.title}</li>
            ))}
          </ol>
        </div>
      );
    case "note":
      // A user Stop is a calm, muted line — not a red error banner, no stop-square.
      if (item.tone === "cancelled") {
        return <div className="note note--cancelled">{item.text}</div>;
      }
      return <div className={`note note--${item.tone}`}>{item.text}</div>;
    case "tool":
      return null;
  }
}

/** An assistant reply: the markdown plus a copy action revealed on hover/focus. */
function AssistantMessage({
  text,
  onOpenFile,
}: {
  text: string;
  onOpenFile: (path: string) => void;
}) {
  const copy = (): void => {
    if (!text) return;
    void window.wello.copyText(text).then(
      () => toast({ message: "Скопировано", tone: "success" }),
      () => toast({ message: "Не удалось скопировать", tone: "danger" }),
    );
  };
  return (
    <div className="msg">
      <Markdown text={text || "…"} onOpenFile={onOpenFile} />
      {text ? (
        <div className="msg__actions">
          <button
            className="icon-button msg__copy"
            title="Скопировать сообщение"
            aria-label="Скопировать сообщение"
            onClick={copy}
          >
            <Icon name="copy" size={13} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

function UserBubble({
  text,
  images,
  attachments,
  onOpenImage,
  onEdit,
  onRewind,
}: {
  text: string;
  images?: string[];
  attachments?: UserAttachment[];
  onOpenImage: (paths: string[], index: number) => void;
  /** Present = this turn can be edited (re-runs the conversation from here). */
  onEdit?: () => void;
  /** Present = this turn has a checkpoint (rewind restores files + conversation). */
  onRewind?: () => void;
}) {
  const hasImages = Boolean(images && images.length > 0);
  return (
    <div className="usermsg">
      <div className="usermsg__stack">
        {hasImages ? <ChatImages paths={images!} onOpen={(i) => onOpenImage(images!, i)} /> : null}
        {attachments && attachments.length > 0 ? (
          <div className="msgatts">
            {attachments.map((a, i) => (
              <span key={i} className="msgatt">
                <span className="msgatt__icon" aria-hidden>
                  <Icon
                    name={a.kind === "folder" ? "folder" : a.kind === "paste" ? "copy" : "file"}
                    size={13}
                  />
                </span>
                <span className="msgatt__label">{a.label}</span>
              </span>
            ))}
          </div>
        ) : null}
        {text ? <div className="usermsg__bubble">{text}</div> : null}
        {onEdit || onRewind ? (
          <div className="usermsg__actions">
            {onRewind ? (
              <button
                className="icon-button usermsg__rewind"
                title="Вернуть проект и диалог к этому ходу"
                aria-label="Вернуться к этому ходу"
                onClick={onRewind}
              >
                <Icon name="undo" size={13} />
              </button>
            ) : null}
            {onEdit ? (
              <button
                className="icon-button usermsg__edit"
                title="Редактировать и перезапустить с этого места"
                aria-label="Редактировать сообщение"
                onClick={onEdit}
              >
                <Icon name="edit" size={13} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Quiet actions under the finished answer: copy the whole reply and, after a
 * failure/cancel, the retry — one row, not two stray blocks.
 */
function AnswerActions({
  onRetry,
  onTopUp,
}: {
  onRetry?: () => void;
  onTopUp?: () => void;
}) {
  return (
    <div className="answer-actions">
      {onTopUp ? (
        <button className="button primary sm" onClick={onTopUp}>
          <Icon name="wallet" size={13} />
          Пополнить баланс
        </button>
      ) : null}
      {onRetry ? (
        <button className="button ghost sm" onClick={onRetry}>
          <Icon name="undo" size={13} />
          Повторить ход
        </button>
      ) : null}
    </div>
  );
}

const CHANGESET_PREVIEW = 4;

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { dir: "", name: path };
  return { dir: path.slice(0, idx + 1), name: path.slice(idx + 1) };
}

/**
 * Inline change-set card. Collapsed by default — just the totals and actions;
 * the header toggles the per-file list open for review.
 */
function ChangeSetCard({
  changes,
  onReview,
  onRevertAll,
  onOpenFile,
}: {
  changes: ChangeSummary;
  onReview: () => void;
  onRevertAll: () => void;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const files = expanded ? changes.files : changes.files.slice(0, CHANGESET_PREVIEW);
  const hidden = changes.files.length - files.length;

  const revert = async (): Promise<void> => {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3500);
      return;
    }
    setConfirming(false);
    setBusy(true);
    try {
      onRevertAll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="changeset wello-rise" aria-label="Изменения в проекте">
      <div className="changeset__head">
        <button
          className="changeset__toggle"
          aria-expanded={open}
          title={open ? "Скрыть список файлов" : "Показать изменённые файлы"}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="changeset__glyph" aria-hidden>
            <Icon name="edit" size={14} />
          </span>
          <div className="changeset__title">
            <strong>
              Изменено {changes.files.length} {plural(changes.files.length, "файл", "файла", "файлов")}
            </strong>
            <span className="pm">
              <em className="pm__add">+{changes.additions}</em> <em className="pm__del">-{changes.deletions}</em>
            </span>
          </div>
          <span className={`activity__chev ${open ? "is-open" : ""}`} aria-hidden>
            <Icon name="chevron" size={12} />
          </span>
        </button>
        <div className="changeset__actions">
          <button
            className={`button ghost sm ${confirming ? "is-danger" : ""}`}
            disabled={busy}
            onClick={() => void revert()}
          >
            <Icon name="undo" size={13} />
            {confirming ? "Точно отменить?" : "Отменить"}
          </button>
          <button className="button primary sm" onClick={onReview}>
            Проверить
          </button>
        </div>
      </div>
      {open ? (
        <>
          <ul className="changeset__files">
            {files.map((f) => {
              const { dir, name } = splitPath(f.path);
              return (
                <li key={f.path} className="changeset__file">
                  <button
                    className="changeset__path"
                    title={`Открыть ${f.path}`}
                    onClick={() => onOpenFile(f.path)}
                  >
                    <span className="changeset__dir">{dir}</span>
                    <span className="changeset__name">{name}</span>
                  </button>
                  <span className="pm">
                    <em className="pm__add">+{f.additions}</em> <em className="pm__del">-{f.deletions}</em>
                  </span>
                </li>
              );
            })}
          </ul>
          {hidden > 0 || expanded ? (
            <button className="changeset__more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Свернуть" : `Показать ещё ${hidden} ${plural(hidden, "файл", "файла", "файлов")}`}
              <span className={`activity__chev ${expanded ? "is-open" : ""}`}>
                <Icon name="chevron" size={12} />
              </span>
            </button>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** Default when the engine has not reported the model's window yet (all catalog Claude models). */
const FALLBACK_CONTEXT_WINDOW = 200_000;

/** «68к» / «3.5к» — thousands with one decimal under 10k. */
function fmtTokensK(n: number): string {
  const k = n / 1000;
  const shown = k >= 10 ? Math.round(k).toString() : (Math.round(k * 10) / 10).toString();
  return `${shown}к`;
}

/**
 * The conversation-context gauge: a small donut that fills as the model's window
 * does (as in web Wello). Hover shows the numbers; click opens a details pop-up.
 */
type SubUsage = Pick<Connection, "billing" | "planId" | "usedFraction">;

function ContextRing({
  used,
  windowTokens,
  sub,
}: {
  used: number | null;
  windowTokens: number | null;
  sub: SubUsage;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDropUp(open, () => setOpen(false), rootRef);
  if (used == null) return null;
  const win = windowTokens ?? FALLBACK_CONTEXT_WINDOW;
  const fraction = win > 0 ? Math.min(1, Math.max(0, used / win)) : 0;
  const pct = Math.round(fraction * 100);
  const tone = pct >= 90 ? "var(--danger)" : pct >= 75 ? "var(--warning)" : "var(--accent)";
  const r = 8;
  const circumference = 2 * Math.PI * r;
  const title = `Контекст диалога: ${fmtTokensK(used)} из ${fmtTokensK(win)} токенов`;
  return (
    <div className="modelsel ctx" ref={rootRef}>
      <button
        className="icon-button"
        title={title}
        aria-label={`${title}, подробнее`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 24 24" className="ctx__ring" aria-hidden>
          <circle cx="12" cy="12" r={r} fill="none" stroke="var(--border-default)" strokeWidth="3" />
          <circle
            cx="12"
            cy="12"
            r={r}
            fill="none"
            stroke={tone}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${fraction * circumference} ${circumference}`}
            transform="rotate(-90 12 12)"
            className="ctx__arc"
          />
        </svg>
      </button>
      {open ? (
        <div className="modelsel__menu ctx__menu" role="dialog" aria-label="Контекст диалога">
          <div className="ctx__head">
            <span className="ctx__label">Контекст диалога</span>
            <span className="ctx__pct" style={{ color: tone }}>
              {pct}%
            </span>
          </div>
          <div className="ctx__bar" aria-hidden>
            <span className="ctx__fill" style={{ width: `${pct}%`, background: tone }} />
          </div>
          <div className="ctx__meta">
            <span>{fmtTokensK(used)} использовано</span>
            <span>{fmtTokensK(Math.max(0, win - used))} свободно</span>
          </div>
          {pct >= 75 ? (
            <p className="ctx__warn">
              <Icon name="dot" size={12} />
              Контекст заполняется — для новой темы лучше начать новую задачу.
            </p>
          ) : null}
          <SubscriptionLimits sub={sub} />
        </div>
      ) : null}
    </div>
  );
}

/** Monthly plan-cap usage shown under the context gauge, subscription only. */
function SubscriptionLimits({ sub }: { sub: SubUsage }) {
  // Since 2026-07 a plan has a single monthly cap that resets on renewal (the old
  // 5-hour/weekly windows are gone) — one bar, same as the web app's limit popup.
  if (sub.billing !== "subscription" || sub.usedFraction == null) return null;
  const pct = Math.round(Math.min(1, Math.max(0, sub.usedFraction)) * 100);
  const tone = pct >= 90 ? "var(--danger)" : pct >= 75 ? "var(--warning)" : "var(--accent)";
  const plan = PLAN_LABELS[sub.planId ?? ""] ?? "Подписка";
  return (
    <div className="ctx__limits">
      <div className="ctx__limits-head">
        <span className="ctx__label">Лимит подписки</span>
        <span className="ctx__plan">{plan}</span>
      </div>
      <div
        className="ctx__win ctx__win--single"
        title={`Использовано ${pct}% лимита на месяц. Лимит сбрасывается при продлении подписки.`}
      >
        <span className="ctx__bar ctx__win-bar" aria-hidden>
          <span className="ctx__fill" style={{ width: `${pct}%`, background: tone }} />
        </span>
        <span className="ctx__win-pct">{pct}%</span>
      </div>
      <p className="ctx__limits-note">На месяц, сброс при продлении подписки</p>
    </div>
  );
}

/**
 * The branch chip in the chat column's bottom line. States: the branch name
 * with ↑N ↓M sync badges (unborn worded «main (нет коммитов)», detached as
 * «HEAD @ abc1234»), the snapshot-tracking chip for a plain folder, and the
 * install hint when git itself is missing. In a repo the click opens the
 * branch popover; the other modes go straight to the review panel (stage 1).
 */
const BranchChip = forwardRef<
  HTMLButtonElement,
  { info: GitBranchInfo; sync: GitSyncInfo | null; onClick: () => void }
>(function BranchChip({ info, sync, onClick }, ref) {
  const label = info.gitMissing
    ? "git не найден"
    : !info.isRepo
      ? "снимок"
      : sync?.detached
        ? `HEAD @ ${sync.head ?? "?"}`
        : info.unborn
          ? `${info.branch ?? "main"} (нет коммитов)`
          : (info.branch ?? "—");
  const title = info.gitMissing
    ? "Установите Git, чтобы включить ветки и коммиты"
    : !info.isRepo
      ? "Папка не является git-репозиторием, изменения отслеживаются снимком"
      : `Ветка: ${label} — синхронизация и ветки`;
  const showSync = Boolean(
    info.isRepo && !info.gitMissing && sync?.upstream && (sync.ahead > 0 || sync.behind > 0),
  );
  return (
    <button
      ref={ref}
      className={`branchchip ${info.isRepo && !info.gitMissing ? "" : "is-muted"}`}
      title={title}
      aria-label={title}
      aria-haspopup={info.isRepo && !info.gitMissing ? "dialog" : undefined}
      onClick={onClick}
    >
      <Icon name="gitbranch" size={12} />
      <span className="branchchip__label">{label}</span>
      {showSync ? (
        <span className="branchchip__sync" aria-label={`Впереди ${sync!.ahead}, позади ${sync!.behind}`}>
          {sync!.ahead > 0 ? <em>↑{sync!.ahead}</em> : null}
          {sync!.behind > 0 ? <em>↓{sync!.behind}</em> : null}
        </span>
      ) : null}
      {/* A popover opens off this chip — say so, like any dropdown control. */}
      {info.isRepo && !info.gitMissing ? (
        <span className="branchchip__caret" aria-hidden>
          <Icon name="chevrondown" size={9} />
        </span>
      ) : null}
    </button>
  );
});

/** Shared close-on-outside-click/Escape behavior for the composer drop-up menus. */
function useDropUp(open: boolean, close: () => void, rootRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close, rootRef]);
}

/** The no-confirmation modes a restricted (untrusted) workspace must not run in. */
const UNATTENDED_MODES: ReadonlySet<TaskMode> = new Set(["auto", "bypass"]);

/** Permission-mode menu (Manual / Accept edits / Plan / Auto / Bypass). */
function ModeSelect({
  value,
  onChange,
  disabled,
  restricted,
}: {
  value: TaskMode;
  onChange: (id: TaskMode) => void;
  disabled: boolean;
  /** Untrusted folder: unattended modes are locked (the runtime enforces too). */
  restricted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDropUp(open, () => setOpen(false), rootRef);
  // A stale global auto/bypass pick in a restricted folder actually runs as
  // «Вручную» (the runtime clamps it) — the button says so honestly.
  const clamped = Boolean(restricted) && UNATTENDED_MODES.has(value);
  const current =
    (clamped ? PERM_MODES.find((m) => m.id === "manual") : undefined) ??
    PERM_MODES.find((m) => m.id === value) ??
    PERM_MODES[0]!;

  return (
    <div className="modelsel" ref={rootRef}>
      <button
        className={`modelsel__button ${current.warn ? "is-warn" : ""}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={
          clamped
            ? "Режим ограничен: папка не доверена, действует «Вручную»"
            : "Режим разрешений"
        }
        onClick={() => setOpen((v) => !v)}
      >
        {current.label}
        <span className={`modelsel__chev ${open ? "is-open" : ""}`} aria-hidden>
          <Icon name="chevron" size={11} />
        </span>
      </button>
      {open ? (
        <div className="modelsel__menu modelsel__menu--left" role="listbox" aria-label="Режим разрешений">
          <p className="modelsel__caption">Режим</p>
          {PERM_MODES.map((m) => {
            const locked = Boolean(restricted) && UNATTENDED_MODES.has(m.id);
            return (
              <button
                key={m.id}
                className={`modelsel__item ${m.warn ? "is-warn" : ""}`}
                role="option"
                aria-selected={m.id === value}
                disabled={locked}
                title={locked ? "Недоступно в ограниченном режиме — доверьте папку в меню чата" : undefined}
                onClick={() => {
                  onChange(m.id);
                  setOpen(false);
                }}
              >
                <span className="modelsel__item-body">
                  <span className="modelsel__item-label">{m.label}</span>
                  <span className="modelsel__item-hint">
                    {locked ? "Требует доверия папке" : m.hint}
                  </span>
                </span>
                {m.id === value ? <Icon name="check" size={13} /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/** Model picker + the Faster ↔ Smarter effort slider, in one drop-up. */
function ModelSelect({
  value,
  onChange,
  effort,
  onEffort,
  disabled,
}: {
  value: string;
  onChange: (id: string) => void;
  effort: Effort;
  onEffort: (e: Effort) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useDropUp(open, () => setOpen(false), rootRef);
  const current = MODELS.find((m) => m.id === value) ?? MODELS[0]!;

  return (
    <div className="modelsel" ref={rootRef}>
      <button
        className="modelsel__button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Модель и усилие"
        onClick={() => setOpen((v) => !v)}
      >
        {current.label}
        <span className={`modelsel__badge ${effort === "ultra" ? "modelsel__badge--ultra" : ""}`}>
          {effort === "ultra" ? "Ультра" : EFFORT_LABEL[effort]}
        </span>
        <span className={`modelsel__chev ${open ? "is-open" : ""}`} aria-hidden>
          <Icon name="chevron" size={11} />
        </span>
      </button>
      {open ? (
        <div className="modelsel__menu" role="listbox" aria-label="Модель">
          <p className="modelsel__caption">Модель</p>
          {MODELS.map((m) => (
            <button
              key={m.id}
              className={`modelsel__item ${m.id === value ? "is-active" : ""}`}
              role="option"
              aria-selected={m.id === value}
              onClick={() => {
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="modelsel__item-body">
                <span className="modelsel__item-label">{m.label}</span>
                <span className="modelsel__item-hint">{m.hint}</span>
              </span>
              {m.id === value ? <Icon name="check" size={13} /> : null}
            </button>
          ))}
          <div className="effort">
            <div className="effort__head">
              <span className="modelsel__caption">Усилие</span>
              <span className={`effort__value ${effort === "ultra" ? "is-ultra" : ""}`}>
                {effort === "ultra" ? "Ультра" : EFFORT_LABEL[effort]}
              </span>
            </div>
            <input
              className={`effort__slider ${effort === "ultra" ? "is-ultra" : ""}`}
              type="range"
              min={0}
              max={EFFORTS.length - 1}
              step={1}
              value={EFFORTS.indexOf(effort)}
              aria-label="Усилие модели"
              onChange={(e) => onEffort(EFFORTS[Number(e.target.value)]!)}
            />
            <div className="effort__scale">
              <span>Быстрее · дешевле</span>
              <span>Умнее · дороже</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Model-initiated clarifying question: pick options (or type your own) and answer. */
function QuestionCard({
  request,
  onAnswer,
}: {
  request: QuestionRequest;
  onAnswer: (answer: QuestionAnswer) => void;
}) {
  const [replies, setReplies] = useState<QuestionReply[]>(() =>
    request.questions.map(() => ({ selected: [], custom: "" })),
  );

  const toggle = (qi: number, label: string, multi: boolean): void => {
    setReplies((prev) =>
      prev.map((r, i) => {
        if (i !== qi) return r;
        if (multi) {
          const has = r.selected.includes(label);
          return { ...r, selected: has ? r.selected.filter((l) => l !== label) : [...r.selected, label] };
        }
        return { ...r, selected: [label] };
      }),
    );
  };

  const setCustom = (qi: number, value: string): void => {
    setReplies((prev) => prev.map((r, i) => (i === qi ? { ...r, custom: value } : r)));
  };

  // Collapse the card into a slim bar docked above the composer (like Claude): the
  // question stays within reach without eating half the screen. A fresh question
  // re-mounts the card (parent keys on request.id), so it always opens expanded.
  const [collapsed, setCollapsed] = useState(false);
  // Questions are answered ONE AT A TIME (Claude Code style), not as a scrolling
  // list: `step` is the visible question.
  const [step, setStep] = useState(0);
  // A Stop-guarded skip: a mis-click shouldn't discard the agent's questions.
  const [skipAsk, setSkipAsk] = useState(false);

  const isReplied = (r: QuestionReply): boolean =>
    r.selected.length > 0 || (r.custom ?? "").trim().length > 0;
  const total = request.questions.length;
  const current = request.questions[Math.min(step, total - 1)]!;
  const currentReplied = isReplied(replies[step] ?? { selected: [], custom: "" });
  const isLast = step >= total - 1;

  const summaryLabel =
    total === 1
      ? request.questions[0]!.header || request.questions[0]!.question
      : `${total} ${plural(total, "вопрос", "вопроса", "вопросов")}`;

  const submit = (): void => {
    onAnswer({
      requestId: request.id,
      answers: replies.map((r) => ({
        selected: r.selected,
        custom: (r.custom ?? "").trim() || undefined,
      })),
    });
  };

  const advance = (): void => {
    if (!currentReplied) return;
    if (isLast) submit();
    else setStep((s) => s + 1);
  };

  const doSkip = (): void => {
    setSkipAsk(false);
    onAnswer({ requestId: request.id, answers: [], skipped: true });
  };

  const skipModal = skipAsk ? (
    <ConfirmModal
      title="Пропустить вопросы?"
      body="Агент задал уточняющие вопросы, чтобы не гадать. Если пропустить, он продолжит на своё усмотрение — результат может разойтись с тем, что вы хотели."
      confirmLabel="Пропустить"
      onCancel={() => setSkipAsk(false)}
      onConfirm={doSkip}
    />
  ) : null;

  if (collapsed) {
    return (
      <>
        <div className="askbar wello-rise" aria-label="Свёрнутый вопрос от агента">
          <button
            className="askbar__toggle"
            onClick={() => setCollapsed(false)}
            title="Развернуть уточняющий вопрос"
          >
            <span className="ask__badge ask__badge--sm" aria-hidden>
              ?
            </span>
            <span className="askbar__label">{summaryLabel}</span>
            {total > 1 ? (
              <span className="askbar__count">
                {step + 1}/{total}
              </span>
            ) : null}
          </button>
          <button className="button ghost sm" onClick={() => setSkipAsk(true)}>
            Пропустить
          </button>
          <button
            className="icon-button"
            onClick={() => setCollapsed(false)}
            title="Развернуть"
            aria-label="Развернуть уточняющий вопрос"
          >
            {/* Up: the card unfolds upward from this bar. */}
            <Icon name="chevronup" size={13} />
          </button>
        </div>
        {skipModal}
      </>
    );
  }

  return (
    <>
      <section className="ask wello-rise" aria-label="Вопрос от агента">
        <div className="ask__head">
          <span className="ask__badge" aria-hidden>
            ?
          </span>
          <strong className="ask__title">Агент уточняет</strong>
          {total > 1 ? (
            <span className="ask__dots" aria-label={`Вопрос ${step + 1} из ${total}`}>
              {request.questions.map((_, i) => (
                <span
                  key={i}
                  className={`ask__dot ${i < step ? "is-done" : i === step ? "is-current" : ""}`}
                />
              ))}
            </span>
          ) : null}
          <span className="ask__head-spacer" />
          <button
            className="icon-button"
            onClick={() => setCollapsed(true)}
            title="Свернуть"
            aria-label="Свернуть уточняющий вопрос"
          >
            {/* Down: the card folds back down into the slim bar. */}
            <Icon name="chevrondown" size={13} />
          </button>
        </div>
        <div className="ask__questions">
          <div className="ask__q">
            {total > 1 ? <span className="ask__chip">{current.header}</span> : null}
            <p className="ask__prompt">{current.question}</p>
            {current.multiSelect ? <span className="ask__multi">Можно выбрать несколько</span> : null}
            <div className="ask__options" role={current.multiSelect ? "group" : "radiogroup"}>
              {current.options.map((opt) => {
                const active = replies[step]?.selected.includes(opt.label) ?? false;
                return (
                  <button
                    key={opt.label}
                    className={`ask__opt ${active ? "is-active" : ""}`}
                    role={current.multiSelect ? "checkbox" : "radio"}
                    aria-checked={active}
                    onClick={() => toggle(step, opt.label, current.multiSelect)}
                  >
                    <span className={`ask__mark ${current.multiSelect ? "is-box" : ""}`} aria-hidden>
                      {active ? <Icon name="check" size={11} /> : null}
                    </span>
                    <span className="ask__opt-body">
                      <span className="ask__opt-label">{opt.label}</span>
                      {opt.description ? <span className="ask__opt-desc">{opt.description}</span> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {/* Outside the scroll region: the free-text answer never gets cropped by
            a long option list — only the options themselves ever scroll. */}
        <input
          className="input ask__custom"
          placeholder="Свой ответ (необязательно)"
          value={replies[step]?.custom ?? ""}
          onChange={(e) => setCustom(step, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && currentReplied) advance();
          }}
        />
        <div className="ask__actions">
          <button className="button ghost sm" onClick={() => setSkipAsk(true)}>
            Пропустить
          </button>
          <span className="ask__actions-spacer" />
          {step > 0 ? (
            <button className="button ghost sm" onClick={() => setStep((s) => s - 1)}>
              Назад
            </button>
          ) : null}
          <button className="button primary sm" disabled={!currentReplied} onClick={advance}>
            {isLast ? "Ответить" : "Далее"}
          </button>
        </div>
      </section>
      {skipModal}
    </>
  );
}

/** Raw capability enum → a plain-language Russian noun for the card header. */
const CAP_LABEL: Record<string, string> = {
  read: "Чтение файлов",
  write: "Изменение файлов",
  command: "Выполнение команды",
  git: "Операция Git",
  network: "Выход в интернет",
  external_url: "Открытие ссылки",
  delete: "Удаление файлов",
};
/** Risk level as words — so it isn't conveyed by the dot color alone. */
const RISK_LABEL: Record<string, string> = {
  low: "низкий риск",
  medium: "средний риск",
  high: "высокий риск",
  critical: "критический риск",
};
const DECISION_LABEL: Record<PermissionDecision, string> = {
  allow_once: "Разрешить один раз",
  allow_for_task: "Разрешить для задачи",
  allow_for_workspace: "Разрешить для проекта",
  deny: "Отклонить",
};
const DECISION_HINT: Record<PermissionDecision, string> = {
  allow_once: "Только для этого действия",
  allow_for_task: "Больше не спрашивать до конца этой задачи",
  allow_for_workspace: "Больше не спрашивать в этом проекте",
  deny: "Не выполнять это действие",
};

/** The single most decision-relevant fact from a request's scope, shown verbatim. */
function permissionScopeDetail(
  request: PermissionRequest,
): { label: string; value: string } | null {
  const s = request.scope;
  if (s.argv && s.argv.length > 0) return { label: "Команда", value: s.argv.join(" ") };
  if (s.host) return { label: "Хост", value: s.host };
  if (s.gitTarget) return { label: "Git", value: s.gitTarget };
  if (s.paths && s.paths.length > 0)
    return { label: s.paths.length > 1 ? "Файлы" : "Файл", value: s.paths.join("\n") };
  return null;
}

function PermissionCard({
  request,
  onRespond,
}: {
  request: PermissionRequest;
  onRespond: (decision: PermissionDecision) => void;
}) {
  const cap = CAP_LABEL[request.capability] ?? request.capability;
  const riskText = RISK_LABEL[request.risk] ?? request.risk;
  const detail = permissionScopeDetail(request);
  const decisions = request.allowedDecisions;
  // The button we autofocus + trigger on Enter: the first allowing decision.
  const primary = decisions.find((d) => d !== "deny") ?? decisions[0] ?? null;
  const primaryRef = useRef<HTMLButtonElement>(null);
  // Focus the primary action so the whole card is answerable from the keyboard
  // (Claude Code: read → Enter approves). Re-focus when a new request arrives.
  useEffect(() => {
    primaryRef.current?.focus();
  }, [request.id]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>): void => {
    if (e.key === "Enter" && primary) {
      e.preventDefault();
      onRespond(primary);
    } else if (e.key === "Escape" && decisions.includes("deny")) {
      e.preventDefault();
      onRespond("deny");
    } else if (/^[1-9]$/.test(e.key)) {
      const pick = decisions[Number(e.key) - 1];
      if (pick) {
        e.preventDefault();
        onRespond(pick);
      }
    }
  };

  return (
    <section
      className="perm wello-rise"
      aria-labelledby="perm-title"
      role="alertdialog"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="perm__head">
        <span className={`perm__risk perm__risk--${request.risk}`} aria-hidden />
        <strong id="perm-title">Требуется разрешение: {cap}</strong>
        <span className={`perm__risklabel perm__risklabel--${request.risk}`}>{riskText}</span>
      </div>
      <p className="perm__reason">{request.reason}</p>
      {detail ? (
        <div className="perm__scope">
          <span className="perm__scope-label">{detail.label}</span>
          <code className="perm__scope-value">{detail.value}</code>
        </div>
      ) : null}
      <ul className="perm__impact">
        {request.impact.map((line, idx) => (
          <li key={idx}>{line}</li>
        ))}
      </ul>
      <div className="perm__actions">
        {decisions.map((d, i) => (
          <button
            key={d}
            ref={d === primary ? primaryRef : undefined}
            className={`button ${d === "deny" ? "ghost" : "primary"} sm`}
            title={DECISION_HINT[d]}
            onClick={() => onRespond(d)}
          >
            {DECISION_LABEL[d]}
            <kbd className="perm__kbd" aria-hidden>{i + 1}</kbd>
          </button>
        ))}
      </div>
      <p className="perm__keyhint">Enter — разрешить · Esc — отклонить · 1–{decisions.length} — выбрать</p>
    </section>
  );
}
