import { describe, expect, it } from "vitest";
import { commandArgString, expandCommandTemplate, splitFrontmatter } from "./slash-template";

describe("splitFrontmatter", () => {
  it("reads fields and returns the body without the block", () => {
    const { fields, body } = splitFrontmatter(
      "---\ndescription: Run the linter\nargument-hint: [path]\n---\nLint $ARGUMENTS please.\n",
    );
    expect(fields).toEqual({ description: "Run the linter", "argument-hint": "[path]" });
    expect(body).toBe("Lint $ARGUMENTS please.\n");
  });

  it("passes bodies with no frontmatter through untouched", () => {
    expect(splitFrontmatter("Just a prompt")).toEqual({ fields: {}, body: "Just a prompt" });
  });

  it("tolerates a BOM and quoted values", () => {
    const { fields } = splitFrontmatter('﻿---\ndescription: "Quoted"\n---\nbody');
    expect(fields.description).toBe("Quoted");
  });
});

describe("expandCommandTemplate", () => {
  it("substitutes $ARGUMENTS", () => {
    expect(expandCommandTemplate("Review $ARGUMENTS carefully", "the login flow")).toBe(
      "Review the login flow carefully",
    );
  });

  it("substitutes positional $1 $2 and blanks missing ones", () => {
    expect(expandCommandTemplate("Move $1 to $2", "a.ts b.ts")).toBe("Move a.ts to b.ts");
    expect(expandCommandTemplate("Only $1 here", "solo")).toBe("Only solo here");
    expect(expandCommandTemplate("Need $2", "one")).toBe("Need");
  });

  it("appends raw args to a template with no placeholders", () => {
    expect(expandCommandTemplate("Refactor this module.", "utils.ts")).toBe(
      "Refactor this module.\n\nutils.ts",
    );
  });

  it("leaves a placeholderless template alone with no args", () => {
    expect(expandCommandTemplate("Summarize the diff.", "")).toBe("Summarize the diff.");
  });
});

describe("commandArgString", () => {
  it("returns everything after the command name", () => {
    expect(commandArgString("/review the login flow")).toBe("the login flow");
    expect(commandArgString("/frontend:component Button")).toBe("Button");
  });

  it("is empty when only the name is present", () => {
    expect(commandArgString("/review")).toBe("");
    expect(commandArgString("/frontend:component")).toBe("");
  });
});
