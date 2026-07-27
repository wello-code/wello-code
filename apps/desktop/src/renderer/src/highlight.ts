import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

/**
 * One shared highlighter for markdown code blocks and the diff viewer.
 * Core build + a curated language set keeps the bundle sane; colors come from
 * design-system tokens (app.css maps .hljs-* onto --code-*), not a hljs theme.
 */
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("c", c);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("java", java);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("php", php);
hljs.registerLanguage("python", python);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);

const ALIASES: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  cs: "csharp",
  "c++": "cpp",
  h: "c",
  hpp: "cpp",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  ps1: "bash",
  yml: "yaml",
  md: "markdown",
  html: "xml",
  htm: "xml",
  svg: "xml",
  vue: "xml",
  svelte: "xml",
  toml: "ini",
  conf: "ini",
  env: "ini",
  scss: "css",
  less: "css",
  sass: "css",
  patch: "diff",
};

/** Normalize a fence tag or file extension to a registered hljs language (or null). */
export function resolveLanguage(tag: string | undefined): string | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  const lang = ALIASES[lower] ?? lower;
  return hljs.getLanguage(lang) ? lang : null;
}

/** Language for a file path, by its extension (for the diff viewer). */
export function languageForPath(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return resolveLanguage(path.slice(dot + 1));
}

/**
 * Highlighting is pure — same source and language, same HTML — but it is not
 * cheap, and the chat asks for the SAME answer over and over: every keystroke of
 * a streaming reply re-renders the thread, and each code block in it is
 * re-highlighted from scratch. Measured on a 20-message thread that is ~18 ms
 * per frame, more than a 60 fps frame budget, before markdown parsing or DOM
 * work — which is exactly what "Wello Code (Не отвечает)" looked like.
 *
 * A small LRU makes the repeat free. Bounded by entry count AND by total
 * characters so a session full of large files cannot grow it without limit; the
 * oldest entry goes first (Map preserves insertion order).
 */
const CACHE_MAX_ENTRIES = 400;
const CACHE_MAX_CHARS = 4_000_000;
/** Blocks bigger than this are rare, and caching them costs more than it saves. */
const CACHE_MAX_ENTRY_CHARS = 200_000;

const cache = new Map<string, string>();
let cachedChars = 0;

function remember(key: string, html: string): void {
  if (html.length > CACHE_MAX_ENTRY_CHARS) return;
  cache.set(key, html);
  cachedChars += html.length;
  while (cache.size > CACHE_MAX_ENTRIES || cachedChars > CACHE_MAX_CHARS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cachedChars -= cache.get(oldest.value)?.length ?? 0;
    cache.delete(oldest.value);
  }
}

/** Highlight `code` as `lang`, returning trusted HTML — or null when unknown/failed. */
export function highlight(code: string, lang: string | null): string | null {
  if (!lang) return null;
  // NUL separates the parts because it can occur in neither. Written as an
  // ESCAPE rather than as the byte itself: a literal control character in the
  // source makes git treat the whole file as binary — no diffs, nothing to review.
  const key = `${lang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh recency: re-inserting moves the key to the end of the Map order.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  try {
    const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    remember(key, html);
    return html;
  } catch {
    return null;
  }
}

/** Test hook: forget everything (the cache is otherwise process-wide). */
export function clearHighlightCache(): void {
  cache.clear();
  cachedChars = 0;
}
