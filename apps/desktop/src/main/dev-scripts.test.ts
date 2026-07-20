import { describe, expect, it } from "vitest";
import { detectDevScripts, detectPackageManager, scrapeDevUrl } from "./dev-scripts";

describe("detectDevScripts", () => {
  it("ranks dev over start and marks the top one recommended", () => {
    const r = detectDevScripts({
      scripts: { start: "node .", dev: "vite", build: "vite build" },
      devDependencies: { vite: "^5" },
    });
    expect(r[0]).toMatchObject({ script: "dev", framework: "Vite", defaultPort: 5173, recommended: true });
    expect(r.find((s) => s.script === "start")?.recommended).toBe(false);
  });

  it("guesses the framework + default port from deps", () => {
    const next = detectDevScripts({ scripts: { dev: "next dev" }, dependencies: { next: "14" } });
    expect(next[0]).toMatchObject({ framework: "Next.js", defaultPort: 3000 });
    const astro = detectDevScripts({ scripts: { dev: "astro dev" }, devDependencies: { astro: "4" } });
    expect(astro[0]).toMatchObject({ framework: "Astro", defaultPort: 4321 });
  });

  it("picks up a serving script under a nonstandard key", () => {
    const r = detectDevScripts({ scripts: { "watch:web": "vite --host", build: "tsc" } });
    expect(r.map((s) => s.script)).toContain("watch:web");
  });

  it("returns nothing when there is no dev-like script", () => {
    expect(detectDevScripts({ scripts: { build: "tsc", test: "vitest" } })).toEqual([]);
  });
});

describe("detectPackageManager", () => {
  it("reads the lockfile", () => {
    expect(detectPackageManager(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectPackageManager(["yarn.lock"])).toBe("yarn");
    expect(detectPackageManager(["bun.lockb"])).toBe("bun");
    expect(detectPackageManager(["package-lock.json"])).toBe("npm");
    expect(detectPackageManager([])).toBe("npm");
  });
});

describe("scrapeDevUrl", () => {
  it("scrapes real dev-server banners and normalizes 0.0.0.0/[::1]", () => {
    expect(scrapeDevUrl("  ➜  Local:   http://localhost:5173/")).toEqual({ host: "localhost", port: 5173 });
    expect(scrapeDevUrl("- Local:        http://localhost:3000")).toEqual({ host: "localhost", port: 3000 });
    expect(scrapeDevUrl("Network: http://0.0.0.0:4321/")).toEqual({ host: "127.0.0.1", port: 4321 });
    expect(scrapeDevUrl("running at http://[::1]:8080")).toEqual({ host: "127.0.0.1", port: 8080 });
  });
  it("returns null when no url is present", () => {
    expect(scrapeDevUrl("Compiling...")).toBeNull();
  });
});
