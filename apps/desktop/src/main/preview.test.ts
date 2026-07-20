import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePreviewRoot } from "./preview-root";
import { safeResolve } from "./preview-server";

describe("safeResolve (preview server path confinement)", () => {
  const root = mkdtempSync(join(tmpdir(), "wello-prevroot-"));

  it("resolves normal paths under the root", () => {
    expect(safeResolve(root, "/")).toBe(root);
    expect(safeResolve(root, "/index.html")).toBe(join(root, "index.html"));
    expect(safeResolve(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
  });

  it("rejects traversal, encoded traversal, and NUL", () => {
    expect(safeResolve(root, "/../secret")).toBeNull();
    expect(safeResolve(root, "/../../etc/passwd")).toBeNull();
    expect(safeResolve(root, "/%2e%2e/secret")).toBeNull();
    expect(safeResolve(root, "/a/%00")).toBeNull();
  });
});

describe("resolvePreviewRoot", () => {
  it("finds index.html in the workspace root", () => {
    const ws = mkdtempSync(join(tmpdir(), "wello-prev-"));
    writeFileSync(join(ws, "index.html"), "<h1>hi</h1>");
    expect(resolvePreviewRoot(ws)).toEqual({ root: ws, entry: "index.html" });
  });

  it("prefers a built dist/ over the root", () => {
    const ws = mkdtempSync(join(tmpdir(), "wello-prev-"));
    mkdirSync(join(ws, "dist"));
    writeFileSync(join(ws, "dist", "index.html"), "<h1>built</h1>");
    writeFileSync(join(ws, "index.html"), "<h1>src</h1>");
    expect(resolvePreviewRoot(ws)).toEqual({ root: join(ws, "dist"), entry: "index.html" });
  });

  it("returns null when there is nothing to preview", () => {
    const ws = mkdtempSync(join(tmpdir(), "wello-prev-"));
    writeFileSync(join(ws, "readme.md"), "no site here");
    expect(resolvePreviewRoot(ws)).toBeNull();
  });
});
