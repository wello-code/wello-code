import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  SETTINGS_GROUPS,
  SETTINGS_PAGES,
  SETTINGS_SEARCH_INDEX,
  loadLastSettingsPage,
  pageLabel,
  saveLastSettingsPage,
  searchSettings,
} from "./settings-nav";

// Node test env has no localStorage — a minimal in-memory stand-in is enough
// for the persistence round-trip (the module already try/catches its absence).
beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  };
});

describe("settings pages", () => {
  it("has the 8 pages in 3 groups (Git after Плагины in Агент)", () => {
    expect(SETTINGS_GROUPS.map((g) => g.label)).toEqual(["Приложение", "Агент", "Аккаунт"]);
    expect(SETTINGS_PAGES.map((p) => p.id)).toEqual([
      "general",
      "appearance",
      "hotkeys",
      "skills",
      "connectors",
      "plugins",
      "git",
      "account",
    ]);
  });

  it("labels resolve", () => {
    expect(pageLabel("appearance")).toBe("Внешний вид");
  });

  it("every index entry points to a real page", () => {
    const ids = new Set(SETTINGS_PAGES.map((p) => p.id));
    for (const e of SETTINGS_SEARCH_INDEX) expect(ids.has(e.page)).toBe(true);
  });
});

describe("searchSettings", () => {
  it("«уведом» finds the notifications row on Общее", () => {
    const hits = searchSettings("уведом");
    expect(hits.some((h) => h.page === "general" && h.rowId === "notifications")).toBe(true);
  });

  it("«тем» finds the theme picker on Внешний вид", () => {
    const hits = searchSettings("тем");
    expect(hits.some((h) => h.page === "appearance" && h.rowId === "theme")).toBe(true);
  });

  it("is case-insensitive and matches descriptions", () => {
    expect(searchSettings("PAYG").some((h) => h.rowId === "payg")).toBe(true);
    expect(searchSettings("payg").some((h) => h.rowId === "payg")).toBe(true);
    // description-only term
    expect(searchSettings("хранилище").some((h) => h.rowId === "key")).toBe(true);
  });

  it("hotkeys are searchable", () => {
    expect(searchSettings("палитра").some((h) => h.page === "hotkeys")).toBe(true);
  });

  it("the Git page is found by its rows", () => {
    expect(searchSettings("префикс").some((h) => h.page === "git" && h.rowId === "git-prefix")).toBe(true);
    expect(searchSettings("черновик").some((h) => h.page === "git" && h.rowId === "git-pr-draft")).toBe(true);
    expect(searchSettings("pull request").some((h) => h.page === "git")).toBe(true);
    expect(searchSettings("коммит").some((h) => h.page === "git" && h.rowId === "git-commit-instr")).toBe(true);
    // the GitHub card moved from Коннекторы to Git
    const gh = searchSettings("github").filter((h) => h.rowId === "github");
    expect(gh.length).toBeGreaterThan(0);
    expect(gh.every((h) => h.page === "git")).toBe(true);
  });

  it("blank and no-match queries return nothing", () => {
    expect(searchSettings("")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
    expect(searchSettings("щщщ-нет-такого")).toEqual([]);
  });
});

describe("last page persistence", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to general", () => {
    expect(loadLastSettingsPage()).toBe("general");
  });

  it("round-trips a saved page", () => {
    saveLastSettingsPage("plugins");
    expect(loadLastSettingsPage()).toBe("plugins");
  });

  it("falls back on junk", () => {
    localStorage.setItem("wello-code-settings-page", "nope");
    expect(loadLastSettingsPage()).toBe("general");
  });
});
