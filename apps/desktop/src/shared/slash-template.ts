/**
 * Project slash commands (Claude Code's `.claude/commands/*.md`): each file is a
 * prompt template. We expand it OURSELVES and drop the result in the composer,
 * rather than relying on the headless engine to interpret a `/name` — the user
 * sees the full prompt and sends it, and there's no double-expansion (the engine
 * receives plain text, no leading slash). Pure helpers here; the main-process
 * scanner reads the files.
 */

export interface ProjectCommand {
  /** Invocation name incl. namespace, e.g. "frontend:component" (no slash). */
  name: string;
  /** One-line description from frontmatter (falls back to the name). */
  description: string;
  /** Optional argument hint from frontmatter, shown after the name in the menu. */
  argumentHint?: string;
  /** The template body (frontmatter stripped). */
  body: string;
}

/** Split a leading `---` YAML-ish frontmatter block; returns the fields + body. */
export function splitFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const src = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/.exec(src);
  if (!m) return { fields: {}, body: src };
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let value = kv[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fields[kv[1]!.toLowerCase()] = value;
  }
  return { fields, body: src.slice(m[0].length) };
}

/**
 * Expand a command template with the user's argument string (everything typed
 * after the command name). `$ARGUMENTS` → the whole string; `$1`,`$2`,… →
 * whitespace-split positionals (missing ones become ""). A template with no
 * placeholders gets the raw arguments appended on a new line, so a bare
 * `/review some note` still carries the note.
 */
export function expandCommandTemplate(body: string, argString: string): string {
  const args = argString.trim();
  const positional = args.length > 0 ? args.split(/\s+/) : [];
  const hasPlaceholder = /\$ARGUMENTS|\$\d+/.test(body);
  let out = body.replace(/\$ARGUMENTS/g, args).replace(/\$(\d+)/g, (_, n) => positional[Number(n) - 1] ?? "");
  if (!hasPlaceholder && args) out = `${out.trimEnd()}\n\n${args}`;
  return out.trim();
}

/** The argument string typed after a `/command` in the composer (empty when none). */
export function commandArgString(input: string): string {
  const m = /^\/[^\s/]+(?::[^\s/]+)?\s+([\s\S]*)$/.exec(input);
  return m ? m[1]! : "";
}
