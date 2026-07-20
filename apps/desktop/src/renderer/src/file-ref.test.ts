import { describe, it, expect } from "vitest";
import { parseFileRef, isRelativeFileHref } from "./file-ref";

describe("parseFileRef — recognises file mentions", () => {
  it("accepts a relative path with an extension", () => {
    expect(parseFileRef("apps/desktop/src/main/index.ts")).toEqual({
      path: "apps/desktop/src/main/index.ts",
    });
  });

  it("accepts a bare name.ext with a known extension", () => {
    expect(parseFileRef("package.json")).toEqual({ path: "package.json" });
    expect(parseFileRef("README.md")).toEqual({ path: "README.md" });
    expect(parseFileRef("app.css")).toEqual({ path: "app.css" });
  });

  it("accepts well-known extensionless files", () => {
    expect(parseFileRef("Dockerfile")).toEqual({ path: "Dockerfile" });
    expect(parseFileRef("Makefile")).toEqual({ path: "Makefile" });
  });

  it("extracts a trailing position marker", () => {
    expect(parseFileRef("index.html (line 255)")).toEqual({ path: "index.html", line: 255 });
    expect(parseFileRef("src/app.ts:42")).toEqual({ path: "src/app.ts", line: 42 });
    expect(parseFileRef("src/app.ts:42:8")).toEqual({ path: "src/app.ts", line: 42 });
    expect(parseFileRef("utils.py#L10")).toEqual({ path: "utils.py", line: 10 });
  });

  it("keeps a Windows drive path intact", () => {
    expect(parseFileRef("C:/proj/x.ts")).toEqual({ path: "C:/proj/x.ts" });
  });
});

describe("parseFileRef — rejects non-files", () => {
  it("rejects commands, flags and prose (whitespace)", () => {
    expect(parseFileRef("npm run dev")).toBeNull();
    expect(parseFileRef("git status")).toBeNull();
  });

  it("rejects bare identifiers and shortcuts", () => {
    expect(parseFileRef("useState")).toBeNull();
    expect(parseFileRef("Ctrl+R")).toBeNull();
    expect(parseFileRef("--flag")).toBeNull();
  });

  it("rejects numbers and versions that look like name.ext", () => {
    expect(parseFileRef("3.14")).toBeNull();
    expect(parseFileRef("v1.0")).toBeNull(); // extension "0" isn't alphabetic
  });

  it("rejects a bare name with an unknown extension", () => {
    expect(parseFileRef("foo.bar")).toBeNull();
    expect(parseFileRef("image.zzz")).toBeNull();
  });

  it("rejects a directory-looking path (last segment has no extension)", () => {
    expect(parseFileRef("src/utils")).toBeNull();
    expect(parseFileRef("apps/desktop/src")).toBeNull();
  });

  it("rejects URLs and emails", () => {
    expect(parseFileRef("https://example.com/a.ts")).toBeNull();
    expect(parseFileRef("user@host.com")).toBeNull();
  });
});

describe("isRelativeFileHref — markdown link targets", () => {
  it("accepts a workspace-relative file href", () => {
    expect(isRelativeFileHref("src/app.ts")).toEqual({ path: "src/app.ts" });
    expect(isRelativeFileHref("./README.md")).toEqual({ path: "README.md" });
  });

  it("rejects schemes and anchors", () => {
    expect(isRelativeFileHref("https://x.com")).toBeNull();
    expect(isRelativeFileHref("mailto:a@b.com")).toBeNull();
    expect(isRelativeFileHref("#section")).toBeNull();
  });
});
