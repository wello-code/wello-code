import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { AppSettings, Connection, McpServerSetting, PluginSetting } from "../../shared/ipc-api";
import { BUNDLED_SKILLS, resolveBundledSkillState } from "../../shared/bundled-skills";
import {
  HOTKEY_ROWS,
  SETTINGS_GROUPS,
  pageLabel,
  searchSettings,
  type SettingsPageId,
} from "./settings-nav";
import { GitHubCard } from "./GitHubConnect";
import { Icon } from "./Icon";
import { toast } from "./Toaster";

/* ------------------------------- Theme ---------------------------------- */

export type ThemeId = "dark" | "dim" | "light" | "system";
const THEME_LS_KEY = "wello-code-theme";
const THEMES: { id: ThemeId; label: string; hint: string }[] = [
  { id: "dark", label: "Тёмная", hint: "Стандартная тема" },
  { id: "dim", label: "Приглушённая", hint: "Меньше контраста для долгих сессий" },
  { id: "light", label: "Светлая", hint: "Дневной режим" },
  { id: "system", label: "Системная", hint: "Следовать теме ОС" },
];

const darkMql =
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
let systemListener: ((e: MediaQueryListEvent) => void) | null = null;

/**
 * Repaints the native window-button overlay (min/max/close, Windows) with the
 * CURRENT theme's header colors — the OS draws those buttons, so a theme switch
 * must be pushed over IPC or they'd stay in the old palette. Reads the resolved
 * tokens so future palette edits stay in sync for free.
 */
export function syncWindowChrome(): void {
  const api = (window as unknown as { wello?: { setTitleBarOverlay?: (o: { color: string; symbolColor: string }) => Promise<void> } }).wello;
  if (!api?.setTitleBarOverlay) return; // bare-browser dev run
  const cs = getComputedStyle(document.documentElement);
  // The OS buttons sit on the titlebar = the CHASSIS layer.
  const color = cs.getPropertyValue("--bg-chrome").trim();
  const symbolColor = cs.getPropertyValue("--text-secondary").trim();
  if (color && symbolColor) void api.setTitleBarOverlay({ color, symbolColor });
}

/** Applies a theme; "system" tracks prefers-color-scheme and updates on change. */
export function applyTheme(theme: ThemeId): void {
  localStorage.setItem(THEME_LS_KEY, theme);
  if (systemListener && darkMql) {
    darkMql.removeEventListener("change", systemListener);
    systemListener = null;
  }
  if (theme === "system") {
    const apply = (): void => {
      document.documentElement.dataset.theme = darkMql?.matches ? "dark" : "light";
      syncWindowChrome();
    };
    apply();
    if (darkMql) {
      systemListener = () => apply();
      darkMql.addEventListener("change", systemListener);
    }
  } else {
    document.documentElement.dataset.theme = theme;
    syncWindowChrome();
  }
}

export function initTheme(): void {
  const saved = localStorage.getItem(THEME_LS_KEY) as ThemeId | null;
  if (saved === "dark" || saved === "dim" || saved === "light" || saved === "system") {
    applyTheme(saved);
  } else {
    // First run keeps the default (dark) theme — the overlay still needs its colors.
    syncWindowChrome();
  }
}

function currentTheme(): ThemeId {
  const saved = localStorage.getItem(THEME_LS_KEY);
  return saved === "dim" || saved === "light" || saved === "system" ? saved : "dark";
}

/* --------------------------- Shared primitives --------------------------- */

/**
 * The ONE switch for every boolean setting (skills, connectors, plugins,
 * notifications, PAYG): a 38×22 track with a 150ms knob, accent when on,
 * `role="switch"` + focus ring, disabled state. Purely presentational — the
 * caller owns the value and persistence, exactly as before.
 */
function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="sw"
      onClick={() => onChange(!checked)}
    >
      <span className="sw__knob" aria-hidden />
    </button>
  );
}

/**
 * One settings row: title + muted description on the left, control(s) right.
 * `rowId` is the search-result anchor (`srow-<rowId>`) the nav scrolls to and
 * pulses — ids come from the static index in settings-nav.ts.
 */
function Row({
  title,
  desc,
  meta,
  control,
  tight,
  rowId,
}: {
  title: ReactNode;
  desc?: ReactNode;
  meta?: ReactNode;
  control?: ReactNode;
  /** Slimmer padding for dense lists (hotkeys). */
  tight?: boolean;
  rowId?: string;
}) {
  return (
    <div className={`srow ${tight ? "srow--tight" : ""}`} id={rowId ? `srow-${rowId}` : undefined}>
      <div className="srow__text">
        <span className="srow__title">{title}</span>
        {desc ? <span className="srow__desc">{desc}</span> : null}
        {meta ? <span className="srow__meta">{meta}</span> : null}
      </div>
      {control ? <div className="srow__ctl">{control}</div> : null}
    </div>
  );
}

/** A group card: hairline border, 12px radius, dividers between rows. */
function Card({ children }: { children: ReactNode }) {
  return <div className="scard">{children}</div>;
}

/** A key sequence as separate keycaps joined by «+» (the hotkeys cheatsheet). */
function HotkeyCombo({ keys }: { keys: string[] }) {
  return (
    <span className="kbdcombo">
      {keys.map((k, i) => (
        <Fragment key={i}>
          {i > 0 ? (
            <span className="kbdcombo__plus" aria-hidden>
              +
            </span>
          ) : null}
          <kbd className="kbdchip">{k}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

/** Dashed empty-state card with an icon, one line and the action inside. */
function EmptyCard({
  icon,
  text,
  actionLabel,
  onAction,
}: {
  icon: "wrench" | "folder";
  text: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="emptycard">
      <span className="emptycard__icon" aria-hidden>
        <Icon name={icon} size={16} />
      </span>
      <span className="emptycard__text">{text}</span>
      <button className="button ghost sm" onClick={onAction}>
        <Icon name="plus" size={13} />
        {actionLabel}
      </button>
    </div>
  );
}

/** Inner section of a page: h2 heading (+ optional description) over cards. */
function Section({
  title,
  desc,
  children,
}: {
  title: string;
  desc?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings__section">
      <h2 className="settings__h">{title}</h2>
      {desc ? <p className="settings__desc">{desc}</p> : null}
      {children}
    </section>
  );
}

/** Page shell: the big page title (+ optional right action and description). */
function PageShell({
  title,
  action,
  desc,
  children,
}: {
  title: string;
  action?: ReactNode;
  desc?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <header className="setpage__intro">
        <div className="setpage__head">
          <h1 className="setpage__title">{title}</h1>
          {action}
        </div>
        {desc ? <p className="setpage__lead">{desc}</p> : null}
      </header>
      {children}
    </>
  );
}

/* ------------------------------ Settings -------------------------------- */

/** How long the found row stays highlighted after a search jump. */
const FLASH_MS = 1500;

/** Identity for the account page (from the app's account state). */
export interface AccountIdentity {
  email: string | null;
  name: string | null;
  plan: string;
}

/**
 * Full-window settings mode (Codex-style): its own grouped nav on the left
 * (return button + live search), one page at a time on the right. The nav
 * collapses via `navOpen` (the titlebar sidebar toggle / Ctrl+B) on the same
 * motion tokens as the app sidebar.
 */
export function SettingsView({
  page,
  onPageChange,
  navOpen,
  onBack,
  onDisconnect,
  account,
}: {
  page: SettingsPageId;
  onPageChange: (page: SettingsPageId) => void;
  navOpen: boolean;
  onBack: () => void;
  onDisconnect: () => void;
  account: AccountIdentity;
}) {
  const [theme, setTheme] = useState<ThemeId>(currentTheme);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [query, setQuery] = useState("");
  // A clicked search result: the target row waits here until ITS page renders,
  // then gets the scroll + pulse (a ref, not state — applying it must not
  // re-trigger the page effect and reset the scroll it just performed).
  const flashRef = useRef<{ page: SettingsPageId; rowId: string } | null>(null);
  const pageScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.wello.getSettings().then(setSettings);
  }, []);

  const persist = (next: AppSettings): void => {
    setSettings(next);
    void window.wello.setSettings(next);
  };

  /** Scroll the found row into view and pulse its background (~1.5s). */
  const flashRow = (rowId: string): void => {
    const el = document.getElementById(`srow-${rowId}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.classList.remove("is-flash");
    // reflush so a repeated jump to the same row restarts the animation
    void el.offsetWidth;
    el.classList.add("is-flash");
    window.setTimeout(() => el.classList.remove("is-flash"), FLASH_MS + 100);
  };

  // Page switched: land at the top — or on the searched row when one is pending.
  useEffect(() => {
    const f = flashRef.current;
    flashRef.current = null;
    if (f && f.page === page) {
      flashRow(f.rowId);
      return;
    }
    if (pageScrollRef.current) pageScrollRef.current.scrollTop = 0;
  }, [page]);

  const results = searchSettings(query);
  const openResult = (target: SettingsPageId, rowId: string): void => {
    setQuery("");
    if (target === page) {
      // Already on the page — no page effect will fire; jump right away.
      flashRow(rowId);
      return;
    }
    flashRef.current = { page: target, rowId };
    onPageChange(target);
  };

  return (
    <div className={`setshell ${navOpen ? "" : "no-nav"}`}>
      <nav className="setnav" aria-label="Настройки">
        <div className="setnav__inner">
          <button className="setnav__back" onClick={onBack}>
            <Icon name="back" size={14} />
            Вернуться в приложение
          </button>
          <div className="setnav__search">
            <Icon name="search" size={13} />
            <input
              id="setnav-search"
              className="setnav__field"
              placeholder="Поиск настроек…"
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // Esc inside the field never leaves settings: with text it
                // clears the search, empty it just drops focus. Stop the event
                // so the app-level Esc (exit settings) can't see it.
                e.preventDefault();
                e.stopPropagation();
                if (query) setQuery("");
                else e.currentTarget.blur();
              }}
            />
          </div>
          {query.trim() ? (
            <div className="setnav__results" role="listbox" aria-label="Результаты поиска">
              {results.length === 0 ? (
                <p className="setnav__none">Ничего не найдено</p>
              ) : (
                results.map((r, i) => (
                  <button
                    key={`${r.page}-${r.rowId}-${i}`}
                    className="setnav__result"
                    role="option"
                    aria-selected={false}
                    onClick={() => openResult(r.page, r.rowId)}
                  >
                    <span className="setnav__rtitle">
                      <span className="setnav__rpage">{pageLabel(r.page)}</span>
                      <span className="setnav__rsep" aria-hidden>
                        ›
                      </span>
                      {r.title}
                    </span>
                    <span className="setnav__rdesc">{r.desc}</span>
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="setnav__groups">
              {SETTINGS_GROUPS.map((g) => (
                <div key={g.label} className="setnav__group">
                  <p className="setnav__caption">{g.label}</p>
                  {g.pages.map((p) => (
                    <button
                      key={p.id}
                      className={`setnav__item ${page === p.id ? "is-active" : ""}`}
                      aria-current={page === p.id ? "page" : undefined}
                      onClick={() => onPageChange(p.id)}
                    >
                      <Icon name={p.icon} size={14} />
                      {p.label}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </nav>

      {/* The panel card; the scroller nests inside so its scrollbar clips at
          the rounded top-left corner. */}
      <div className="setpage">
        <div className="setpage__scroll" ref={pageScrollRef}>
        <div className="setpage__inner">
          {page === "general" ? (
            <GeneralPage settings={settings} persist={persist} />
          ) : page === "appearance" ? (
            <PageShell title="Внешний вид">
              <div id="srow-theme">
                <ThemePicker
                  value={theme}
                  onChange={(t) => {
                    setTheme(t);
                    applyTheme(t);
                  }}
                />
              </div>
            </PageShell>
          ) : page === "hotkeys" ? (
            <PageShell title="Горячие клавиши">
              <Card>
                {HOTKEY_ROWS.map((h) => (
                  <Row
                    key={h.id}
                    rowId={`hotkey-${h.id}`}
                    tight
                    title={h.desc}
                    control={<HotkeyCombo keys={h.keys} />}
                  />
                ))}
              </Card>
            </PageShell>
          ) : page === "skills" ? (
            <PageShell
              title="Скиллы"
              desc="Наборы инструкций — агент подхватывает их сам, когда задача подходит. Дизайн-скилл включён сразу."
            >
              {settings ? (
                <>
                  <Section
                    title="Мои скиллы"
                    desc="Папки со SKILL.md, которые вы добавили сами. Новый скилл включается автоматически."
                  >
                    <UserSkillsCard
                      state={settings.userSkills}
                      onChange={(userSkills) => persist({ ...settings, userSkills })}
                    />
                  </Section>
                  <Section title="Встроенные">
                    <BundledSkillsCard
                      state={settings.bundledSkills}
                      onChange={(bundledSkills) => persist({ ...settings, bundledSkills })}
                    />
                  </Section>
                </>
              ) : null}
            </PageShell>
          ) : page === "connectors" ? (
            settings ? (
              <McpPage
                servers={settings.mcpServers}
                onChange={(mcpServers) => persist({ ...settings, mcpServers })}
              />
            ) : null
          ) : page === "plugins" ? (
            settings ? (
              <PluginsPage
                plugins={settings.plugins}
                onChange={(plugins) => persist({ ...settings, plugins })}
              />
            ) : null
          ) : page === "git" ? (
            <GitPage settings={settings} persist={persist} />
          ) : (
            <AccountPage account={account} onDisconnect={onDisconnect} />
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- General --------------------------------- */

/** Общее = notifications + about (name/version with the copy button). */
function GeneralPage({
  settings,
  persist,
}: {
  settings: AppSettings | null;
  persist: (next: AppSettings) => void;
}) {
  const [version, setVersion] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void window.wello.getAppInfo().then((i) => setVersion(i.version));
  }, []);
  const copy = (): void => {
    void window.wello.copyText(`Wello Code v${version}`).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => toast({ message: "Не удалось скопировать", tone: "danger" }),
    );
  };
  return (
    <PageShell title="Общее">
      <Section title="Уведомления">
        <Card>
          <Row
            rowId="notifications"
            title="Системные уведомления"
            desc="Уведомление, когда задача готова или агент ждёт ответа — пока окно свёрнуто или не в фокусе."
            control={
              settings ? (
                <Switch
                  checked={settings.notifications !== false}
                  onChange={(v) => persist({ ...settings, notifications: v })}
                  label="Системные уведомления"
                />
              ) : undefined
            }
          />
        </Card>
      </Section>
      <Section title="О приложении">
        <Card>
          <Row
            rowId="about"
            title="Wello Code"
            desc={version ? `Версия ${version}` : "Версия…"}
            control={
              <span className="aboutcopy">
                {copied ? (
                  <span className="aboutcopy__done" role="status">
                    Скопировано
                  </span>
                ) : null}
                <button
                  className="icon-button"
                  title="Скопировать версию"
                  aria-label="Скопировать название и версию"
                  onClick={copy}
                >
                  <Icon name="copy" size={14} />
                </button>
              </span>
            }
          />
        </Card>
      </Section>
    </PageShell>
  );
}

/* ------------------------------ Appearance ------------------------------- */

/**
 * Theme picker: an equal-tile radiogroup with mini-previews. Full keyboard
 * radio semantics — arrows move AND apply the selection (roving tabindex), the
 * theme flips instantly exactly as the click path always did.
 */
function ThemePicker({ value, onChange }: { value: ThemeId; onChange: (t: ThemeId) => void }) {
  const pick = (t: ThemeId, focusEl?: HTMLElement | null): void => {
    onChange(t);
    focusEl?.focus();
  };
  return (
    <div
      className="settings__themes"
      role="radiogroup"
      aria-label="Тема оформления"
      onKeyDown={(e) => {
        const idx = THEMES.findIndex((t) => t.id === value);
        let next = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (idx + 1) % THEMES.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp")
          next = (idx - 1 + THEMES.length) % THEMES.length;
        if (next < 0) return;
        e.preventDefault();
        const t = THEMES[next]!;
        pick(
          t.id,
          e.currentTarget.querySelector<HTMLElement>(`[data-theme-id="${t.id}"]`),
        );
      }}
    >
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={value === t.id}
          tabIndex={value === t.id ? 0 : -1}
          data-theme-id={t.id}
          className={`themecard themecard--${t.id} ${value === t.id ? "is-active" : ""}`}
          onClick={() => pick(t.id)}
        >
          <span className="themecard__preview" aria-hidden>
            <span className="themecard__chip" />
            <span className="themecard__line" />
            <span className="themecard__line short" />
          </span>
          <span className="themecard__label">{t.label}</span>
          <span className="themecard__hint">{t.hint}</span>
          {value === t.id ? (
            <span className="themecard__check" aria-hidden>
              <Icon name="check" size={11} />
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

/* ----------------------------- User skills ------------------------------ */

/**
 * The user's own skills (the app-owned my-skills plugin folder). The list is a
 * fresh main-process scan; «Открыть папку» creates the skeleton and reveals it,
 * «Обновить» re-scans after the user dropped folders in. A skill with no entry
 * in the settings map is ON — dropping a folder is the opt-in.
 */
function UserSkillsCard({
  state,
  onChange,
}: {
  state: Record<string, boolean> | undefined;
  onChange: (next: Record<string, boolean>) => void;
}) {
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string }>>([]);
  const [scanned, setScanned] = useState(false);
  const rescan = async (): Promise<void> => {
    const found = await window.wello.listUserSkills().catch(() => []);
    setSkills(found);
    setScanned(true);
  };
  useEffect(() => {
    void rescan();
  }, []);
  // Re-scan when the window regains focus — the user was likely in the folder.
  useEffect(() => {
    const onFocus = (): void => void rescan();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const openFolder = (): void => void window.wello.openUserSkillsFolder();

  if (scanned && skills.length === 0) {
    return (
      <EmptyCard
        icon="folder"
        text="Положите в папку скиллов подпапку со SKILL.md (имя и описание — во frontmatter) — агент подхватит её в следующем ране."
        actionLabel="Открыть папку"
        onAction={openFolder}
      />
    );
  }
  return (
    <>
      <Card>
        {skills.map((s) => (
          <Row
            key={s.id}
            rowId={`user-skill-${s.id}`}
            title={s.name}
            desc={s.description || "Без описания"}
            meta={`my-skills/${s.id}`}
            control={
              <Switch
                checked={state?.[s.id] !== false}
                onChange={(v) => onChange({ ...(state ?? {}), [s.id]: v })}
                label={s.name}
              />
            }
          />
        ))}
      </Card>
      <div className="skillactions">
        <button className="button ghost sm" onClick={openFolder}>
          <Icon name="folder" size={13} />
          Открыть папку
        </button>
        <button className="button ghost sm" onClick={() => void rescan()}>
          Обновить список
        </button>
      </div>
    </>
  );
}

/* --------------------------- Bundled skills ----------------------------- */

/** Toggle card for the skills that ship with the app (design taste v2 etc.). */
function BundledSkillsCard({
  state,
  onChange,
}: {
  state: Record<string, boolean> | undefined;
  onChange: (next: Record<string, boolean>) => void;
}) {
  const resolved = resolveBundledSkillState(state);
  const toggle = (id: string, enabled: boolean): void => {
    onChange({ ...resolved, [id]: enabled });
  };

  return (
    <Card>
      {BUNDLED_SKILLS.map((s) => (
        <Row
          key={s.id}
          rowId={`skill-${s.id}`}
          title={s.name}
          desc={s.description}
          meta={s.source}
          control={
            <Switch checked={resolved[s.id] ?? false} onChange={(v) => toggle(s.id, v)} label={s.name} />
          }
        />
      ))}
    </Card>
  );
}

/* --------------------------------- Git ----------------------------------- */

/**
 * Настройки Git: префикс новых веток (валидируется через check-ref-format на
 * сохранении), инструкции для генераций коммит-сообщений/описаний PR и дефолт
 * «Черновика» в Create PR. Читаются потребителями в момент использования —
 * правки работают сразу.
 */
function GitPage({
  settings,
  persist,
}: {
  settings: AppSettings | null;
  persist: (next: AppSettings) => void;
}) {
  const [prefix, setPrefix] = useState<string | null>(null);
  const [prefixError, setPrefixError] = useState<string | null>(null);
  const savedPrefix = settings?.gitBranchPrefix ?? "";
  const shownPrefix = prefix ?? savedPrefix;

  const savePrefix = async (): Promise<void> => {
    if (!settings || prefix === null || prefix === savedPrefix) return;
    const res = await window.wello.gitValidateBranchPrefix(prefix.trim());
    if (!res.ok) {
      setPrefixError(res.error ?? "Недопустимый префикс ветки.");
      return;
    }
    setPrefixError(null);
    setPrefix(null);
    persist({ ...settings, gitBranchPrefix: prefix.trim() });
  };

  return (
    <PageShell title="Git">
      <Section title="Ветки">
        <Card>
          <Row
            rowId="git-prefix"
            title="Префикс новых веток"
            desc="Подставляется в поле «Новая ветка» в поповере ветки; его можно стереть."
            control={
              <input
                className="sfield"
                placeholder="wello/"
                value={shownPrefix}
                spellCheck={false}
                onChange={(e) => {
                  setPrefix(e.target.value);
                  setPrefixError(null);
                }}
                onBlur={() => void savePrefix()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void savePrefix();
                }}
              />
            }
          />
          {prefixError ? (
            <p className="srow__error" role="alert">
              {prefixError}
            </p>
          ) : null}
        </Card>
      </Section>
      <Section title="Коммиты">
        <Card>
          <InstructionsRow
            rowId="git-commit-instr"
            title="Инструкции для сообщений коммитов"
            desc="Модель учтёт их, когда будет писать сообщение коммита за вас — язык, стиль, формат."
            placeholder="Например: сообщения на английском, в стиле conventional commits"
            value={settings?.gitCommitInstructions ?? ""}
            disabled={!settings}
            onSave={(v) => settings && persist({ ...settings, gitCommitInstructions: v })}
          />
        </Card>
      </Section>
      <Section title="Pull requests">
        <Card>
          <Row
            rowId="git-pr-draft"
            title="Создавать PR черновиками"
            desc="Галка «Черновик» в окне нового pull request включена по умолчанию — разово её можно снять прямо там."
            control={
              settings ? (
                <Switch
                  checked={settings.gitPrDraftDefault !== false}
                  onChange={(v) => persist({ ...settings, gitPrDraftDefault: v })}
                  label="Создавать PR черновиками"
                />
              ) : undefined
            }
          />
          <InstructionsRow
            rowId="git-pr-instr"
            title="Инструкции для описаний PR"
            desc="Модель учтёт их, когда будет писать описание pull request за вас."
            placeholder="Например: описания на английском, со списком изменений и чек-листом тестов"
            value={settings?.gitPrInstructions ?? ""}
            disabled={!settings}
            onSave={(v) => settings && persist({ ...settings, gitPrInstructions: v })}
          />
        </Card>
      </Section>
      <Section title="GitHub">
        <GitHubCard />
      </Section>
    </PageShell>
  );
}

/** A full-width instructions textarea row (saved on blur, like the prefix). */
function InstructionsRow({
  rowId,
  title,
  desc,
  placeholder,
  value,
  disabled,
  onSave,
}: {
  rowId: string;
  title: string;
  desc: string;
  placeholder: string;
  value: string;
  disabled?: boolean;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  return (
    <div className="srow srow--stack" id={`srow-${rowId}`}>
      <div className="srow__text">
        <span className="srow__title">{title}</span>
        <span className="srow__desc">{desc}</span>
      </div>
      <textarea
        className="sinstr"
        rows={3}
        placeholder={placeholder}
        value={shown}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && draft !== value) onSave(draft.trim());
          setDraft(null);
        }}
      />
    </div>
  );
}

/* ------------------------------- Account -------------------------------- */

/**
 * Аккаунт = profile (e-mail + plan chip), the access-key row, the payment
 * section (the account-wide PAYG switch + balance) and sign-out — the button
 * hands off to the app's existing confirmation modal.
 */
function AccountPage({
  account,
  onDisconnect,
}: {
  account: AccountIdentity;
  onDisconnect: () => void;
}) {
  const [conn, setConn] = useState<Connection | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.wello.getConnection().then(setConn);
  }, []);

  const togglePayg = (enabled: boolean): void => {
    if (busy) return;
    setBusy(true);
    void window.wello
      .setPaygOverflow(enabled)
      .then((next) => {
        setConn(next);
        if (next.error) toast({ message: next.error, tone: "danger" });
      })
      .finally(() => setBusy(false));
  };

  return (
    <PageShell title="Аккаунт">
      <Section title="Профиль">
        <Card>
          <Row
            rowId="profile"
            title={account.name ?? account.email ?? "Аккаунт Wello"}
            desc={account.name ? (account.email ?? undefined) : "Почта аккаунта Wello"}
            control={<span className="acctmenu__plan">{account.plan}</span>}
          />
          <Row
            rowId="key"
            title="Ключ доступа"
            desc="Хранится в системном хранилище учётных данных этого компьютера."
          />
        </Card>
      </Section>
      <Section title="Оплата">
        {!conn ? (
          <Card>
            <Row title="Загрузка…" />
          </Card>
        ) : conn.planActive ? (
          <Card>
            {(() => {
              // Mirrors the web app: overflow can't be TURNED ON with an empty
              // balance (there is nothing to overflow into); turning it off is
              // always allowed.
              const overflowOn = conn.overflowEnabled === true;
              const cantEnable = !overflowOn && (conn.balanceCents ?? 0) <= 0;
              return (
                <Row
                  rowId="payg"
                  title="Оплата сверх лимита (PAYG)"
                  desc={
                    cantEnable
                      ? "Когда месячный лимит подписки исчерпан, продолжать работу с баланса по фактическому расходу. Чтобы включить, пополните баланс — сейчас на нём $0."
                      : "Когда месячный лимит подписки исчерпан, продолжать работу с баланса по фактическому расходу. Настройка общая для всего аккаунта Wello."
                  }
                  control={
                    <span title={cantEnable ? "Пополните баланс, чтобы включить" : undefined}>
                      <Switch
                        checked={overflowOn}
                        disabled={busy || conn.overflowEnabled == null || cantEnable}
                        onChange={togglePayg}
                        label="Оплата сверх лимита (PAYG)"
                      />
                    </span>
                  }
                />
              );
            })()}
            {conn.balanceCents != null ? (
              <Row
                rowId="balance"
                title="Баланс PAYG"
                control={
                  <span className="srow__ctlgroup">
                    <span className="balancechip">${(conn.balanceCents / 100).toFixed(2)}</span>
                    {(conn.balanceCents ?? 0) <= 0 ? (
                      <button
                        className="button secondary sm"
                        onClick={() =>
                          void window.wello.openExternal("https://wello.dev/settings/balance#topup")
                        }
                      >
                        Пополнить
                      </button>
                    ) : null}
                  </span>
                }
              />
            ) : null}
          </Card>
        ) : (
          <Card>
            <Row
              rowId="payg"
              title="Подписки нет"
              desc={
                "Wello Code входит в тарифы Pro и выше. Сейчас работа оплачивается по факту (PAYG) с баланса" +
                (conn.balanceCents != null ? ` — на нём $${(conn.balanceCents / 100).toFixed(2)}` : "") +
                "."
              }
              control={
                <button
                  className="button secondary sm"
                  onClick={() =>
                    void window.wello.openExternal("https://wello.dev/settings/billing#plans")
                  }
                >
                  Оформить подписку
                </button>
              }
            />
          </Card>
        )}
      </Section>
      <Card>
        <Row
          rowId="signout"
          title="Выйти из аккаунта"
          desc="Ключ доступа будет отозван на этом компьютере."
          control={
            <button className="button secondary sm acctout" onClick={onDisconnect}>
              <Icon name="power" size={13} />
              Выйти из аккаунта
            </button>
          }
        />
      </Card>
    </PageShell>
  );
}

/* --------------------------- MCP connectors ----------------------------- */

function McpPage({
  servers,
  onChange,
}: {
  servers: McpServerSetting[];
  onChange: (next: McpServerSetting[]) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpServerSetting["transport"]>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");

  const valid =
    name.trim().length > 0 &&
    (transport === "stdio" ? command.trim().length > 0 : /^https?:\/\//i.test(url.trim()));

  const add = (): void => {
    if (!valid) return;
    onChange([
      ...servers,
      {
        id: crypto.randomUUID(),
        name: name.trim(),
        enabled: true,
        transport,
        command: transport === "stdio" ? command.trim() : undefined,
        args: transport === "stdio" ? args.trim() || undefined : undefined,
        url: transport === "stdio" ? undefined : url.trim(),
      },
    ]);
    setAdding(false);
    setName("");
    setCommand("");
    setArgs("");
    setUrl("");
  };

  return (
    <PageShell
      title="Коннекторы"
      action={
        !adding ? (
          <button className="button ghost sm" onClick={() => setAdding(true)}>
            <Icon name="plus" size={13} />
            Добавить
          </button>
        ) : undefined
      }
      desc="Внешние инструменты для агента (Model Context Protocol). Подключаются к каждой новой задаче; вызовы проходят через обычные разрешения."
    >
      <div id="srow-mcp" className="setpage__anchor">
        {servers.length === 0 && !adding ? (
          <EmptyCard
            icon="wrench"
            text="Пока не подключено ни одного коннектора."
            actionLabel="Добавить коннектор"
            onAction={() => setAdding(true)}
          />
        ) : null}
        {servers.length > 0 ? (
          <Card>
            {servers.map((s) => (
              <Row
                key={s.id}
                title={s.name}
                meta={s.transport === "stdio" ? `${s.command}${s.args ? " " + s.args : ""}` : s.url}
                control={
                  <>
                    <Switch
                      checked={s.enabled}
                      onChange={(v) =>
                        onChange(servers.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)))
                      }
                      label={s.name}
                    />
                    <button
                      className="icon-button"
                      title="Удалить"
                      aria-label={`Удалить ${s.name}`}
                      onClick={() => onChange(servers.filter((x) => x.id !== s.id))}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </>
                }
              />
            ))}
          </Card>
        ) : null}
        {adding ? (
          <div className="setform">
            <div className="setform__grid">
              <label className="field">
                <span className="label">Название</span>
                <input
                  className="input"
                  placeholder="например, github"
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="field">
                <span className="label">Тип</span>
                <div className="segment" role="group" aria-label="Тип коннектора">
                  {(["stdio", "http", "sse"] as const).map((t) => (
                    <button
                      key={t}
                      className="segment-button"
                      aria-pressed={transport === t}
                      onClick={() => setTransport(t)}
                    >
                      {t === "stdio" ? "Команда" : t.toUpperCase()}
                    </button>
                  ))}
                </div>
              </label>
            </div>
            {transport === "stdio" ? (
              <div className="setform__grid">
                <label className="field">
                  <span className="label">Команда</span>
                  <input
                    className="input"
                    placeholder="npx"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span className="label">Аргументы</span>
                  <input
                    className="input"
                    placeholder="-y @modelcontextprotocol/server-github"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                  />
                </label>
              </div>
            ) : (
              <label className="field">
                <span className="label">URL</span>
                <input
                  className="input"
                  placeholder="https://example.com/mcp"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </label>
            )}
            <div className="setform__actions">
              <button className="button ghost sm" onClick={() => setAdding(false)}>
                Отмена
              </button>
              <button className="button primary sm" disabled={!valid} onClick={add}>
                Добавить коннектор
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </PageShell>
  );
}

/* ------------------------------- Plugins -------------------------------- */

function PluginsPage({
  plugins,
  onChange,
}: {
  plugins: PluginSetting[];
  onChange: (next: PluginSetting[]) => void;
}) {
  const addFolder = async (): Promise<void> => {
    const path = await window.wello.pickFolder("Выберите папку плагина или скилла");
    if (!path) return;
    if (plugins.some((p) => p.path === path)) return;
    onChange([...plugins, { id: crypto.randomUUID(), path, enabled: true }]);
  };

  return (
    <PageShell
      title="Плагины"
      action={
        <button className="button ghost sm" onClick={() => void addFolder()}>
          <Icon name="plus" size={13} />
          Добавить папку
        </button>
      }
      desc="Локальные папки с плагинами Claude Code (скиллы, команды, субагенты) — подключаются к движку при каждой задаче."
    >
      <div id="srow-plugins" className="setpage__anchor">
        {plugins.length === 0 ? (
          <EmptyCard
            icon="folder"
            text="Плагины не добавлены."
            actionLabel="Добавить папку"
            onAction={() => void addFolder()}
          />
        ) : (
          <Card>
            {plugins.map((p) => (
              <Row
                key={p.id}
                title={<span className="srow__path">{p.path}</span>}
                control={
                  <>
                    <Switch
                      checked={p.enabled}
                      onChange={(v) =>
                        onChange(plugins.map((x) => (x.id === p.id ? { ...x, enabled: v } : x)))
                      }
                      label={p.path}
                    />
                    <button
                      className="icon-button"
                      title="Удалить"
                      aria-label="Удалить плагин"
                      onClick={() => onChange(plugins.filter((x) => x.id !== p.id))}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </>
                }
              />
            ))}
          </Card>
        )}
      </div>
    </PageShell>
  );
}
