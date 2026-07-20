/**
 * User skills: the user drops Claude Code skill folders (each with a SKILL.md)
 * into an app-owned plugin directory; every enabled one loads into runs exactly
 * like the bundled set. Pure helpers here (frontmatter parsing) — shared by the
 * main-process scanner and unit tests. No node/electron imports.
 */

/** plugin.json `name` of the user-skills plugin dir — the skill namespace. */
export const USER_PLUGIN_NAME = "my-skills";

export interface UserSkillInfo {
  /** Stable id == the folder name under <userData>/user-skills/skills/. */
  id: string;
  /** Display name: frontmatter `name` or the folder id. */
  name: string;
  /** One-line description from the frontmatter ("" when none). */
  description: string;
}

/**
 * Minimal SKILL.md frontmatter reader: a leading `---` block of `key: value`
 * lines (the same fields Claude Code reads — name/description). No YAML lib on
 * purpose: values are treated as plain strings, quotes trimmed, everything else
 * ignored. Returns {} when there is no frontmatter at all.
 */
export function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
  // Tolerate a UTF-8 BOM (Notepad saves them) before the opening fence.
  const src = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(src);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.+)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1] as "name" | "description";
    let value = kv[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (value && out[key] === undefined) out[key] = value.slice(0, 300);
  }
  return out;
}

/** A folder name usable as a skill id (what the engine accepts as a dir name). */
export function isValidSkillId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
}

/**
 * The names for the SDK's explicit `skills` filter: both the bare folder name
 * and the plugin-qualified form, same contract as the bundled set.
 */
export function userSkillFilterNames(ids: string[]): string[] {
  const names: string[] = [];
  for (const id of ids) names.push(id, `${USER_PLUGIN_NAME}:${id}`);
  return names;
}

/** Enabled = no explicit `false` in the settings map (new skills are on). */
export function enabledUserSkillIds(
  skills: UserSkillInfo[],
  saved?: Record<string, boolean> | null,
): string[] {
  return skills.filter((s) => saved?.[s.id] !== false).map((s) => s.id);
}
