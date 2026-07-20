import { createRequire } from "node:module";
import { cp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Portable Windows build without electron-builder: copy the Electron runtime and
 * stage the app under resources/app (no asar — the SDK must spawn its bundled
 * claude.exe straight from disk). The main bundle externalizes exactly one runtime
 * dependency (@anthropic-ai/claude-agent-sdk); everything else is bundled by
 * electron-vite, so the staged node_modules is just the SDK + its win32 binary.
 *
 * Run from apps/desktop after `pnpm build`:  node scripts/package-win.mjs
 */
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(join(appRoot, "package.json"));

const outDir = join(appRoot, "release");
const distDir = join(outDir, "WelloCode-win-x64");
const stagedApp = join(distDir, "resources", "app");

/**
 * Real directory of an installed package: resolve the pnpm symlink under the
 * consumer's node_modules directly (require.resolve can't be used — the SDK's
 * `exports` map does not expose ./package.json).
 */
async function packageDir(fromDir, name) {
  return realpath(join(fromDir, "node_modules", ...name.split("/")));
}

async function main() {
  const desktopPkg = JSON.parse(await readFile(join(appRoot, "package.json"), "utf8"));

  // 1. Fresh output with the Electron runtime as the base.
  const electronDist = dirname(await realpath(require_.resolve("electron/package.json")));
  await rm(outDir, { recursive: true, force: true });
  await mkdir(distDir, { recursive: true });
  await cp(join(electronDist, "dist"), distDir, { recursive: true, dereference: true });
  await rm(join(distDir, "resources", "default_app.asar"), { force: true });

  // 2. Stage the app: manifest + built bundles.
  await mkdir(stagedApp, { recursive: true });
  await writeFile(
    join(stagedApp, "package.json"),
    JSON.stringify(
      {
        name: "wello-code",
        productName: "Wello Code",
        version: desktopPkg.version,
        private: true,
        type: "module",
        main: "out/main/index.js",
      },
      null,
      2,
    ),
  );
  await cp(join(appRoot, "out"), join(stagedApp, "out"), { recursive: true });

  // 2b. Bundled skills (data, not code — vite doesn't touch them). Resolved at
  // runtime as `<out/main>/../../skills-bundle`, i.e. resources/app/skills-bundle.
  await cp(join(appRoot, "skills-bundle"), join(stagedApp, "skills-bundle"), { recursive: true });

  // 2c. Runtime brand assets, resolved the same way (`<out/main>/../../resources`).
  // The window icon lives here. Note the .exe's OWN icon is not set by this script:
  // renaming the Electron binary leaves its embedded resources untouched, so the
  // Explorer/taskbar icon only becomes ours once the electron-builder target lands
  // (build/icon.ico is already prepared for it).
  await cp(join(appRoot, "resources"), join(stagedApp, "resources"), { recursive: true });

  // 3. The only runtime node_modules: the agent SDK and its Windows binary.
  // (sdk.mjs bundles its JS deps; optional platform packages are pnpm-linked as
  // SIBLINGS of the real SDK dir, not under its own node_modules.)
  const sdkDir = await packageDir(appRoot, "@anthropic-ai/claude-agent-sdk");
  const sdkContainer = dirname(dirname(sdkDir));
  const winDir = await realpath(
    join(sdkContainer, "@anthropic-ai", "claude-agent-sdk-win32-x64"),
  );
  for (const [name, src] of [
    ["@anthropic-ai/claude-agent-sdk", sdkDir],
    ["@anthropic-ai/claude-agent-sdk-win32-x64", winDir],
  ]) {
    const dest = join(stagedApp, "node_modules", ...name.split("/"));
    await mkdir(dirname(dest), { recursive: true });
    await cp(src, dest, {
      recursive: true,
      dereference: false,
      // The SDK's own node_modules holds symlinks to every platform binary — the
      // flat copy above provides the one we need, so skip them all.
      filter: (p) => !p.slice(src.length).includes("node_modules"),
    });
  }

  // 4. Name the executable, then stamp our identity into it. Renaming alone leaves
  // Electron's own icon and version strings embedded in the binary, so Explorer,
  // the taskbar and the file's Properties tab all still said "Electron".
  const exePath = join(distDir, "Wello Code.exe");
  await rename(join(distDir, "electron.exe"), exePath);

  if (process.platform === "win32") {
    // CommonJS exporting `{ rcedit }` (not a bare function, and no default), so
    // reach it through require and destructure rather than `import rcedit from`.
    const { rcedit } = require_("rcedit");
    await rcedit(exePath, {
      icon: join(appRoot, "build", "icon.ico"),
      "version-string": {
        ProductName: "Wello Code",
        FileDescription: "Wello Code",
        CompanyName: "Wello",
        LegalCopyright: "Copyright 2026 Wello. Apache License 2.0.",
        OriginalFilename: "Wello Code.exe",
      },
      // Windows wants a 4-part file version; the product version stays semver.
      "file-version": `${desktopPkg.version}.0`,
      "product-version": desktopPkg.version,
    });
  } else {
    console.warn("skipping icon/metadata stamp: rcedit only runs on Windows");
  }

  console.log(`Portable build ready: ${distDir}`);
  console.log("Zip the folder and run 'Wello Code.exe' on the target PC.");
}

await main();
