// Fails if any feature CSS uses a raw color literal instead of a semantic token.
// The token source file (packages/design-system/tokens.css) is the ONE place raw
// palette hex is allowed — everything else must reference var(--…).
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..", "..", ".."); // packages/design-system/scripts -> repo root
const SCAN_DIRS = ["apps", "packages"];
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "build", ".vite", "coverage"]);
const ALLOW_FILES = new Set(["packages/design-system/tokens.css"]);
const HEX = /#[0-9a-fA-F]{3,8}\b/g;

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      yield full;
    }
  }
}

const violations = [];
for (const base of SCAN_DIRS) {
  for await (const file of walk(join(repoRoot, base))) {
    const rel = relative(repoRoot, file).split("\\").join("/");
    if (ALLOW_FILES.has(rel)) continue;
    const text = await readFile(file, "utf8");
    text.split("\n").forEach((line, i) => {
      const matches = line.match(HEX);
      if (matches) violations.push(`${rel}:${i + 1}  ${matches.join(", ")}`);
    });
  }
}

if (violations.length > 0) {
  console.error("token-lint: raw color literals in feature CSS (use var(--…) tokens instead):");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("token-lint: OK — no raw color literals in feature CSS.");
