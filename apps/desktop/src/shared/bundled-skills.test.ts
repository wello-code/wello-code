import { describe, expect, it } from "vitest";
import {
  BUNDLED_PLUGIN_NAME,
  BUNDLED_SKILLS,
  bundledSkillFilterNames,
  defaultBundledSkillState,
  enabledBundledSkillIds,
  resolveBundledSkillState,
} from "./bundled-skills";

describe("bundled-skills catalog", () => {
  it("ships taste v2 on by default and the rest off", () => {
    const def = defaultBundledSkillState();
    expect(def["design-taste-frontend"]).toBe(true);
    expect(def["frontend-design"]).toBe(false);
    expect(def["skill-creator"]).toBe(false);
    expect(def["mcp-builder"]).toBe(false);
  });

  it("has an entry per catalog skill and no proprietary doc skills", () => {
    const ids = BUNDLED_SKILLS.map((s) => s.id);
    expect(ids).toContain("design-taste-frontend");
    for (const forbidden of ["pdf", "xlsx", "docx", "pptx"]) {
      expect(ids).not.toContain(forbidden);
    }
  });
});

describe("resolveBundledSkillState", () => {
  it("fills missing ids with their default", () => {
    const state = resolveBundledSkillState({ "frontend-design": true });
    expect(state["frontend-design"]).toBe(true); // saved override
    expect(state["design-taste-frontend"]).toBe(true); // default kept
    expect(state["mcp-builder"]).toBe(false); // default kept
  });

  it("drops unknown ids and covers every catalog skill", () => {
    const state = resolveBundledSkillState({ "ghost-skill": true });
    expect(state).not.toHaveProperty("ghost-skill");
    expect(Object.keys(state).sort()).toEqual(BUNDLED_SKILLS.map((s) => s.id).sort());
  });

  it("treats null/undefined as a fresh install", () => {
    expect(resolveBundledSkillState(null)).toEqual(defaultBundledSkillState());
    expect(resolveBundledSkillState(undefined)).toEqual(defaultBundledSkillState());
  });
});

describe("enabledBundledSkillIds", () => {
  it("returns only the on skills", () => {
    expect(enabledBundledSkillIds(null)).toEqual(["design-taste-frontend"]);
    const all = enabledBundledSkillIds({
      "design-taste-frontend": true,
      "frontend-design": true,
      "skill-creator": false,
      "mcp-builder": true,
    });
    expect(all).toEqual(["design-taste-frontend", "frontend-design", "mcp-builder"]);
  });

  it("can be emptied by turning everything off", () => {
    expect(enabledBundledSkillIds({ "design-taste-frontend": false })).toEqual([]);
  });
});

describe("bundledSkillFilterNames", () => {
  it("emits the bare and plugin-qualified name for each id", () => {
    expect(bundledSkillFilterNames(["design-taste-frontend"])).toEqual([
      "design-taste-frontend",
      `${BUNDLED_PLUGIN_NAME}:design-taste-frontend`,
    ]);
  });

  it("maps nothing to nothing", () => {
    expect(bundledSkillFilterNames([])).toEqual([]);
  });
});
