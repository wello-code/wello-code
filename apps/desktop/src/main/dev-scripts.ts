import type { DevScriptInfo } from "../shared/ipc-api";

/**
 * Pure detection of a workspace's dev server (no electron import → vitest-testable):
 * which package.json script to run, which framework/default port it implies, which
 * package manager to drive it, and how to scrape the ready URL from its stdout.
 */

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/** Framework → (dep markers, default port). Order = detection priority. */
const FRAMEWORKS: Array<{ name: string; deps: string[]; port: number }> = [
  { name: "Next.js", deps: ["next"], port: 3000 },
  { name: "Nuxt", deps: ["nuxt"], port: 3000 },
  { name: "Astro", deps: ["astro"], port: 4321 },
  { name: "SvelteKit", deps: ["@sveltejs/kit"], port: 5173 },
  { name: "Remix", deps: ["@remix-run/dev", "@remix-run/serve"], port: 3000 },
  { name: "Angular", deps: ["@angular/cli"], port: 4200 },
  { name: "Vue CLI", deps: ["@vue/cli-service"], port: 8080 },
  { name: "CRA", deps: ["react-scripts"], port: 3000 },
  { name: "Parcel", deps: ["parcel"], port: 1234 },
  { name: "Vite", deps: ["vite"], port: 5173 },
];

/** Script keys likely to start a dev server, most preferred first. */
const SCRIPT_RANK = ["dev", "start", "dev:web", "develop", "serve", "preview"];

function frameworkFor(pkg: PackageJson): { name: string; port: number } | null {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const fw of FRAMEWORKS) {
    if (fw.deps.some((d) => d in deps)) return { name: fw.name, port: fw.port };
  }
  return null;
}

/** Candidate dev scripts in package.json, best first (recommended = top). */
export function detectDevScripts(pkg: PackageJson): DevScriptInfo[] {
  const scripts = pkg.scripts ?? {};
  const fw = frameworkFor(pkg);
  const found = SCRIPT_RANK.filter((k) => k in scripts);
  // A script whose body clearly serves (vite/next dev/…) even under a nonstandard key.
  for (const [key, body] of Object.entries(scripts)) {
    if (found.includes(key)) continue;
    if (/\b(vite|next dev|astro dev|nuxt dev|ng serve|parcel|webpack serve|serve)\b/.test(body)) {
      found.push(key);
    }
  }
  return found.map((script, i) => ({
    script,
    framework: fw?.name ?? null,
    defaultPort: fw?.port ?? 3000,
    recommended: i === 0,
  }));
}

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

/** Package manager from the lockfiles present in the workspace. */
export function detectPackageManager(lockfiles: string[]): PackageManager {
  const set = new Set(lockfiles.map((f) => f.toLowerCase()));
  if (set.has("pnpm-lock.yaml")) return "pnpm";
  if (set.has("yarn.lock")) return "yarn";
  if (set.has("bun.lockb") || set.has("bun.lock")) return "bun";
  return "npm";
}

/** The first loopback URL a dev server prints (0.0.0.0/[::1] normalized to 127.0.0.1). */
export function scrapeDevUrl(line: string): { host: string; port: number } | null {
  const m = /https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})/i.exec(line);
  if (!m) return null;
  let host = m[1]!;
  if (host === "0.0.0.0" || host === "[::1]") host = "127.0.0.1";
  return { host, port: Number(m[2]) };
}
