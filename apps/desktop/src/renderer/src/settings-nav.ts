/**
 * The settings mode's static shape: the page registry (grouped left-nav) and
 * the search index over every settings row. Pure data + pure functions — the
 * SettingsView renders FROM this module and the search filters over it, so the
 * nav, the pages and the search can never drift apart.
 */
import { BUNDLED_SKILLS } from "../../shared/bundled-skills";
import { HOTKEYS, hotkeyKeys } from "./hotkeys";
import type { IconName } from "./Icon";

export type SettingsPageId =
  | "general"
  | "appearance"
  | "hotkeys"
  | "skills"
  | "connectors"
  | "plugins"
  | "git"
  | "account";

export interface SettingsPage {
  id: SettingsPageId;
  label: string;
  icon: IconName;
}

export interface SettingsGroup {
  label: string;
  pages: SettingsPage[];
}

/** Grouped nav, top to bottom (order == render order). */
export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: "Приложение",
    pages: [
      { id: "general", label: "Общее", icon: "gear" },
      { id: "appearance", label: "Внешний вид", icon: "sun" },
      { id: "hotkeys", label: "Горячие клавиши", icon: "keyboard" },
    ],
  },
  {
    label: "Агент",
    pages: [
      { id: "skills", label: "Скиллы", icon: "rocket" },
      { id: "connectors", label: "Коннекторы", icon: "wrench" },
      { id: "plugins", label: "Плагины", icon: "folder" },
      { id: "git", label: "Git", icon: "gitbranch" },
    ],
  },
  {
    label: "Аккаунт",
    pages: [{ id: "account", label: "Аккаунт", icon: "user" }],
  },
];

export const SETTINGS_PAGES: SettingsPage[] = SETTINGS_GROUPS.flatMap((g) => g.pages);

export function pageLabel(id: SettingsPageId): string {
  return SETTINGS_PAGES.find((p) => p.id === id)?.label ?? "Настройки";
}

/**
 * The hotkey cheatsheet rows = the live registry + the typed-character
 * triggers (@ and / follow the produced character, not a physical chord).
 * `keys` is the key SEQUENCE — the page renders one keycap per entry with «+»
 * between them. The Hotkeys page AND the search index render from this list.
 */
export const HOTKEY_ROWS: { id: string; keys: string[]; desc: string }[] = [
  ...HOTKEYS.map((h) => ({ id: h.id, keys: hotkeyKeys(h), desc: h.desc })),
  { id: "mention", keys: ["@"], desc: "Упомянуть файл проекта" },
  { id: "slash", keys: ["/"], desc: "Слэш-команды" },
  { id: "send", keys: ["Enter"], desc: "Отправить (Shift+Enter — перенос)" },
];

export interface SettingsSearchEntry {
  page: SettingsPageId;
  /** Anchor id of the row (`srow-<rowId>` in the DOM) the result scrolls to. */
  rowId: string;
  title: string;
  desc: string;
}

/** Static index: one entry per settings row (page › title, desc underneath). */
export const SETTINGS_SEARCH_INDEX: SettingsSearchEntry[] = [
  {
    page: "general",
    rowId: "notifications",
    title: "Системные уведомления",
    desc: "Уведомление, когда задача готова или агент ждёт ответа — пока окно свёрнуто или не в фокусе.",
  },
  {
    page: "general",
    rowId: "about",
    title: "О приложении",
    desc: "Название и версия Wello Code — с копированием.",
  },
  {
    page: "appearance",
    rowId: "theme",
    title: "Тема оформления",
    desc: "Тёмная, приглушённая, светлая или системная.",
  },
  ...HOTKEY_ROWS.map((h) => ({
    page: "hotkeys" as const,
    rowId: `hotkey-${h.id}`,
    title: h.desc,
    desc: h.keys.join(" + "),
  })),
  {
    page: "skills",
    rowId: "user-skills",
    title: "Мои скиллы",
    desc: "Собственные скиллы: папки со SKILL.md в папке my-skills — включаются автоматически.",
  },
  ...BUNDLED_SKILLS.map((s) => ({
    page: "skills" as const,
    rowId: `skill-${s.id}`,
    title: s.name,
    desc: s.description,
  })),
  {
    page: "connectors",
    rowId: "mcp",
    title: "MCP-коннекторы",
    desc: "Внешние инструменты для агента (Model Context Protocol) — подключаются к каждой новой задаче.",
  },
  {
    page: "connectors",
    rowId: "mcp",
    title: "Добавить коннектор",
    desc: "Команда (stdio), HTTP или SSE.",
  },
  {
    page: "plugins",
    rowId: "plugins",
    title: "Плагины и скиллы",
    desc: "Локальные папки с плагинами Claude Code — скиллы, команды, субагенты.",
  },
  {
    page: "plugins",
    rowId: "plugins",
    title: "Добавить папку плагина",
    desc: "Подключается к движку при каждой задаче.",
  },
  {
    page: "git",
    rowId: "git-prefix",
    title: "Префикс новых веток",
    desc: "Подставляется в поле «Новая ветка» — например, wello/.",
  },
  {
    page: "git",
    rowId: "git-commit-instr",
    title: "Инструкции для сообщений коммитов",
    desc: "Язык и стиль автосообщений коммитов — например, conventional commits.",
  },
  {
    page: "git",
    rowId: "git-pr-draft",
    title: "Создавать PR черновиками",
    desc: "Галка «Черновик» в окне нового pull request включена по умолчанию.",
  },
  {
    page: "git",
    rowId: "git-pr-instr",
    title: "Инструкции для описаний PR",
    desc: "Язык и стиль автоописаний pull request.",
  },
  {
    page: "git",
    rowId: "github",
    title: "GitHub",
    desc: "Подключение по одноразовому коду — репозитории, отправка кода и pull request из приложения.",
  },
  {
    page: "account",
    rowId: "profile",
    title: "Профиль",
    desc: "Почта и тариф аккаунта Wello.",
  },
  {
    page: "account",
    rowId: "key",
    title: "Ключ доступа",
    desc: "Хранится в системном хранилище учётных данных этого компьютера.",
  },
  {
    page: "account",
    rowId: "payg",
    title: "Оплата сверх лимита (PAYG)",
    desc: "Когда месячный лимит подписки исчерпан, продолжать работу с баланса по фактическому расходу.",
  },
  {
    page: "account",
    rowId: "balance",
    title: "Баланс PAYG",
    desc: "Текущий баланс оплаты по факту.",
  },
  {
    page: "account",
    rowId: "signout",
    title: "Выйти из аккаунта",
    desc: "Отозвать ключ доступа на этом компьютере.",
  },
];

/** Case-insensitive live filter over title+description, index order kept. */
export function searchSettings(query: string): SettingsSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTINGS_SEARCH_INDEX.filter(
    (e) => e.title.toLowerCase().includes(q) || e.desc.toLowerCase().includes(q),
  );
}

/* ------------------------- Last-page persistence ------------------------- */

const PAGE_LS_KEY = "wello-code-settings-page";

export function loadLastSettingsPage(): SettingsPageId {
  try {
    const saved = localStorage.getItem(PAGE_LS_KEY);
    if (saved && SETTINGS_PAGES.some((p) => p.id === saved)) return saved as SettingsPageId;
  } catch {
    /* storage unavailable — default below */
  }
  return "general";
}

export function saveLastSettingsPage(id: SettingsPageId): void {
  try {
    localStorage.setItem(PAGE_LS_KEY, id);
  } catch {
    /* best-effort */
  }
}
