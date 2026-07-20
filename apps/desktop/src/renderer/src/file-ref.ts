/**
 * Recognises a file mention inside agent output (an inline-code span or a
 * relative markdown link) so it can be turned into a click that opens the file
 * in the inspector — the "answer → code" navigation from the Codex reference.
 *
 * Deliberately conservative: only strings that clearly name a source file match,
 * so ordinary inline code (`Ctrl+R`, `npm run dev`, `useState`, `--flag`) never
 * becomes a spurious link. A path either contains a separator with an extensioned
 * last segment, or is a bare `name.ext` whose extension is a known code/text kind.
 */

/** Extensions we treat as openable files when a bare `name.ext` is mentioned. */
const KNOWN_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "jsonc",
  "md", "mdx", "txt", "rst",
  "css", "scss", "sass", "less", "html", "htm", "xml", "svg", "vue", "svelte",
  "py", "go", "rs", "java", "kt", "kts", "rb", "php", "c", "h", "cpp", "hpp",
  "cc", "cs", "swift", "m", "mm", "sh", "bash", "zsh", "fish", "ps1",
  "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "lock",
  "sql", "graphql", "gql", "proto", "prisma", "dockerfile", "makefile",
]);

/** A recognised file reference: the path to open plus an optional 1-based line. */
export interface FileRef {
  path: string;
  line?: number;
}

/** Strips a trailing position marker — `:12`, `:12:5`, ` (line 12)`, `#L12` — returning it. */
function splitPosition(raw: string): { path: string; line?: number } {
  const s = raw.trim();
  // " (line 12)" or " (line 12, col 3)"
  const paren = /\s*\(line\s+(\d+)(?:\s*,\s*col(?:umn)?\s+\d+)?\)\s*$/i.exec(s);
  if (paren) return { path: s.slice(0, paren.index).trim(), line: Number(paren[1]) };
  // "#L12"
  const hash = /#L(\d+)\s*$/.exec(s);
  if (hash) return { path: s.slice(0, hash.index).trim(), line: Number(hash[1]) };
  // ":12" or ":12:5" (but not a bare "8080" port or a Windows drive "C:")
  const colon = /:(\d+)(?::\d+)?\s*$/.exec(s);
  if (colon && colon.index > 0) {
    const before = s.slice(0, colon.index);
    // Keep a Windows drive prefix intact ("C:\\x.ts") — only split a real ":line".
    if (!/^[a-zA-Z]$/.test(before)) return { path: before.trim(), line: Number(colon[1]) };
  }
  return { path: s };
}

const HAS_SEP = /[\\/]/;
const BARE_NAME = /^[\w.@-]+\.([a-zA-Z][a-zA-Z0-9]{0,7})$/;
const LAST_SEG_EXT = /\.([a-zA-Z][a-zA-Z0-9]{0,7})$/;

/**
 * Parses a raw inline string into a FileRef, or null when it doesn't look like a
 * file. Rejects URLs, emails and whitespace-containing strings up front.
 */
export function parseFileRef(raw: string): FileRef | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 260) return null;
  if (/:\/\//.test(trimmed) || trimmed.includes("@")) return null; // url / email

  // Strip a trailing position marker (which may contain a space, e.g. "(line 12)")
  // BEFORE the whitespace guard, so the remaining path is checked for spaces —
  // a command like "npm run dev" still falls out here.
  const { path, line } = splitPosition(trimmed);
  if (!path || /\s/.test(path)) return null;

  if (HAS_SEP.test(path)) {
    // A path: require the LAST segment to carry a file extension (so "src/utils"
    // — a directory — doesn't masquerade as a file).
    const lastSeg = path.split(/[\\/]/).pop() ?? "";
    if (!LAST_SEG_EXT.test(lastSeg)) {
      // Allow well-known extensionless files (Dockerfile, Makefile) as a last segment.
      if (!KNOWN_EXTENSIONS.has(lastSeg.toLowerCase())) return null;
    }
    return line != null ? { path, line } : { path };
  }

  // A bare name: must be `name.ext` with a known extension, OR a known
  // extensionless filename (Dockerfile, Makefile).
  const m = BARE_NAME.exec(path);
  if (m && KNOWN_EXTENSIONS.has(m[1]!.toLowerCase())) {
    return line != null ? { path, line } : { path };
  }
  if (KNOWN_EXTENSIONS.has(path.toLowerCase())) {
    return line != null ? { path, line } : { path };
  }
  return null;
}

/** Whether a markdown link href points at a workspace-relative file (not a URL). */
export function isRelativeFileHref(href: string | undefined): FileRef | null {
  if (!href) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null; // has a scheme (http:, mailto:, …)
  if (href.startsWith("#") || href.startsWith("//")) return null;
  return parseFileRef(href.replace(/^\.\//, ""));
}
