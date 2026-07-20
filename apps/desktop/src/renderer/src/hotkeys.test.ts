import { describe, expect, it } from "vitest";
import { COMMAND_KEY, HOTKEYS, hotkeyKeys, matchHotkey } from "./hotkeys";

const ev = (code: string, mods: Partial<KeyboardEvent> = {}) => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("matchHotkey", () => {
  it("matches by PHYSICAL key, so layouts cannot break it", () => {
    // Ctrl+K on a Russian layout produces the character «л», but code stays KeyK.
    expect(matchHotkey(ev("KeyK", { ctrlKey: true }))).toBe("palette");
    expect(matchHotkey(ev("KeyF", { ctrlKey: true }))).toBe("chatSearch");
    expect(matchHotkey(ev("KeyN", { ctrlKey: true }))).toBe("newTask");
    expect(matchHotkey(ev("KeyB", { ctrlKey: true }))).toBe("sidebar");
    expect(matchHotkey(ev("Backquote", { ctrlKey: true }))).toBe("terminal");
    expect(matchHotkey(ev("Comma", { ctrlKey: true }))).toBe("settings");
    expect(matchHotkey(ev("Tab", { ctrlKey: true }))).toBe("termNext");
  });

  it("requires the command modifier and rejects alt/shift combos", () => {
    expect(matchHotkey(ev("KeyK"))).toBeNull();
    expect(matchHotkey(ev("KeyK", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(matchHotkey(ev("KeyK", { ctrlKey: true, altKey: true }))).toBeNull();
    expect(matchHotkey(ev("KeyQ", { ctrlKey: true }))).toBeNull();
  });

  it("keeps ids unique and codes unique (one physical chord per action)", () => {
    expect(new Set(HOTKEYS.map((h) => h.id)).size).toBe(HOTKEYS.length);
    expect(new Set(HOTKEYS.map((h) => h.code)).size).toBe(HOTKEYS.length);
  });
});

describe("hotkeyKeys (cheatsheet keycaps)", () => {
  it("prepends the platform command key; terminal tabs stay plain Ctrl", () => {
    const palette = HOTKEYS.find((h) => h.id === "palette")!;
    expect(hotkeyKeys(palette)).toEqual([COMMAND_KEY, "K"]);
    const termNext = HOTKEYS.find((h) => h.id === "termNext")!;
    expect(hotkeyKeys(termNext)).toEqual(["Ctrl", "Tab"]);
  });

  it("every registry entry renders as modifier + one key", () => {
    for (const h of HOTKEYS) {
      const keys = hotkeyKeys(h);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(h.key);
    }
  });
});
