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

/**
 * Escape hatches, because some colours genuinely must not follow the theme: the
 * ANSI terminal palette is a fixed spec, a mask gradient's #000 means "opaque"
 * rather than black, and a theme-preview swatch has to render the OTHER theme.
 * A reason is mandatory — an unexplained opt-out is how a rule quietly dies.
 *
 * Written as CSS comments (shown here without their delimiters):
 *   token-lint-ignore: why              — silences that one line
 *   token-lint-ignore-start: why        — silences until…
 *   token-lint-ignore-end               — …here
 */
const IGNORE_LINE = /token-lint-ignore:\s*\S/;
const IGNORE_START = /token-lint-ignore-start:\s*\S/;
const IGNORE_END = /token-lint-ignore-end/;
// An opt-out with no reason after the colon is itself an error.
const IGNORE_BARE = /token-lint-ignore(-start)?:?\s*(\*\/|$)/;

const violations = [];
const bareOptOuts = [];
for (const base of SCAN_DIRS) {
  for await (const file of walk(join(repoRoot, base))) {
    const rel = relative(repoRoot, file).split("\\").join("/");
    if (ALLOW_FILES.has(rel)) continue;
    const text = await readFile(file, "utf8");
    let suppressed = false;
    text.split("\n").forEach((line, i) => {
      if (IGNORE_END.test(line)) suppressed = false;
      if (IGNORE_BARE.test(line) && !IGNORE_END.test(line)) {
        bareOptOuts.push(`${rel}:${i + 1}  token-lint-ignore without a reason`);
      }
      const startsRange = IGNORE_START.test(line);
      const skipThisLine = suppressed || startsRange || IGNORE_LINE.test(line);
      if (startsRange) suppressed = true;
      if (skipThisLine) return;
      const matches = line.match(HEX);
      if (matches) violations.push(`${rel}:${i + 1}  ${matches.join(", ")}`);
    });
  }
}

if (bareOptOuts.length > 0) {
  console.error("token-lint: token-lint-ignore must state a reason:");
  for (const v of bareOptOuts) console.error("  " + v);
  process.exit(1);
}

if (violations.length > 0) {
  console.error("token-lint: raw color literals in feature CSS (use var(--…) tokens instead):");
  for (const v of violations) console.error("  " + v);
  process.exit(1);
}
console.log("token-lint: OK — no raw color literals in feature CSS.");
