import { describe, expect, it } from "vitest";
import {
  enabledUserSkillIds,
  isValidSkillId,
  parseSkillFrontmatter,
  userSkillFilterNames,
} from "./user-skills";

describe("parseSkillFrontmatter", () => {
  it("reads name and description from a standard block", () => {
    const fm = parseSkillFrontmatter(
      "---\nname: My Skill\ndescription: Does a thing well\n---\n\n# Body\n",
    );
    expect(fm).toEqual({ name: "My Skill", description: "Does a thing well" });
  });

  it("trims quotes and handles CRLF", () => {
    const fm = parseSkillFrontmatter('---\r\nname: "Quoted"\r\ndescription: \'Single\'\r\n---\r\nbody');
    expect(fm).toEqual({ name: "Quoted", description: "Single" });
  });

  it("returns {} without a frontmatter block", () => {
    expect(parseSkillFrontmatter("# Just markdown\n")).toEqual({});
    expect(parseSkillFrontmatter("")).toEqual({});
  });

  it("ignores unknown keys and keeps the first occurrence", () => {
    const fm = parseSkillFrontmatter(
      "---\nversion: 2\nname: First\nname: Second\nallowed-tools: Bash\n---\n",
    );
    expect(fm).toEqual({ name: "First" });
  });

  it("caps runaway values", () => {
    const fm = parseSkillFrontmatter(`---\ndescription: ${"x".repeat(1000)}\n---\n`);
    expect(fm.description).toHaveLength(300);
  });
});

describe("isValidSkillId", () => {
  it("accepts plain folder names and rejects path-ish ones", () => {
    expect(isValidSkillId("my-skill")).toBe(true);
    expect(isValidSkillId("Skill.v2_x")).toBe(true);
    expect(isValidSkillId("../escape")).toBe(false);
    expect(isValidSkillId(".hidden")).toBe(false);
    expect(isValidSkillId("has space")).toBe(false);
    expect(isValidSkillId("")).toBe(false);
  });
});

describe("filter + enable maps", () => {
  it("emits bare and plugin-qualified names", () => {
    expect(userSkillFilterNames(["a"])).toEqual(["a", "my-skills:a"]);
  });

  it("treats a missing entry as enabled and false as off", () => {
    const skills = [
      { id: "a", name: "a", description: "" },
      { id: "b", name: "b", description: "" },
      { id: "c", name: "c", description: "" },
    ];
    expect(enabledUserSkillIds(skills, { b: false, c: true })).toEqual(["a", "c"]);
    expect(enabledUserSkillIds(skills, null)).toEqual(["a", "b", "c"]);
  });
});
