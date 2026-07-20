/**
 * THE hotkey registry: every Ctrl/⌘-combo the app owns, keyed by `e.code` so
 * shortcuts survive keyboard layouts (Ctrl+K stays on the K KEY under РУС too).
 * The global handler (App.tsx), scoped handlers (terminal tabs) and the
 * Settings cheatsheet all read THIS list — they cannot drift apart.
 *
 * Deliberately NOT here: «@» and «/» — those are typed-character triggers
 * inside the composer and must follow the produced character (e.key/input),
 * not the physical key.
 */

export interface Hotkey {
  id: "palette" | "chatSearch" | "newTask" | "sidebar" | "terminal" | "settings" | "termNext";
  /** Physical key (KeyboardEvent.code). */
  code: string;
  /** Human key name for cheatsheets/tooltips — the modifier is prepended per
   *  platform by hotkeyKeys(). */
  key: string;
  desc: string;
  /** Plain Ctrl on EVERY platform (terminal tabs), not the ⌘ command key. */
  ctrlAlways?: boolean;
  /** Registered but handled by a focused surface, not the global handler. */
  scoped?: boolean;
}

export const HOTKEYS: Hotkey[] = [
  { id: "palette", code: "KeyK", key: "K", desc: "Палитра команд" },
  { id: "chatSearch", code: "KeyF", key: "F", desc: "Поиск по чатам" },
  { id: "newTask", code: "KeyN", key: "N", desc: "Новая задача" },
  { id: "sidebar", code: "KeyB", key: "B", desc: "Боковая панель" },
  { id: "terminal", code: "Backquote", key: "`", desc: "Терминал" },
  { id: "settings", code: "Comma", key: ",", desc: "Настройки" },
  {
    id: "termNext",
    code: "Tab",
    key: "Tab",
    desc: "Следующая вкладка терминала",
    ctrlAlways: true,
    scoped: true,
  },
];

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform ?? "");

/** The platform's command-modifier name for cheatsheets: ⌘ on macOS, Ctrl elsewhere. */
export const COMMAND_KEY = IS_MAC ? "⌘" : "Ctrl";

/** The cheat-sheet key sequence of a registry hotkey, e.g. ["Ctrl", "K"]. */
export function hotkeyKeys(h: Hotkey): string[] {
  return [h.ctrlAlways ? "Ctrl" : COMMAND_KEY, h.key];
}

/** The platform command modifier: ⌘ on macOS, Ctrl elsewhere. */
export function commandModifier(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey">): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey;
}

/**
 * Which registered hotkey (if any) this keydown is. Alt/Shift combos are not
 * ours; the wrong-platform modifier does not match.
 */
export function matchHotkey(
  e: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): Hotkey["id"] | null {
  if (!commandModifier(e) || e.altKey || e.shiftKey) return null;
  return HOTKEYS.find((h) => h.code === e.code)?.id ?? null;
}
