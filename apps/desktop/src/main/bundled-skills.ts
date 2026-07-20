import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  bundledSkillFilterNames,
  enabledBundledSkillIds,
} from "../shared/bundled-skills";

/**
 * Absolute path of the shipped skills plugin. `import.meta.dirname` is the built
 * main dir (`.../out/main`) in BOTH dev and the packaged app, and the bundle sits
 * two levels up next to `out/` (dev: apps/desktop/skills-bundle; packaged:
 * resources/app/skills-bundle — package-win.mjs copies it there). Returns null if
 * the folder is missing so a stripped build degrades to "no bundled skills".
 */
export function bundledSkillsDir(): string | null {
  const dir = join(import.meta.dirname, "..", "..", "skills-bundle");
  return existsSync(join(dir, ".claude-plugin", "plugin.json")) ? dir : null;
}

/** Immediate subdirectory names of `dir` (empty on any fs error). */
function subdirNames(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Skill names discovered in the user's own enabled plugins (`<plugin>/skills/*`).
 * They must join the explicit `skills` filter, otherwise turning the filter on for
 * our bundled skills would hide the user's plugin skills too.
 */
export function userPluginSkillNames(pluginPaths: string[]): string[] {
  const names: string[] = [];
  for (const p of pluginPaths) {
    const skillsDir = join(p, "skills");
    if (existsSync(skillsDir)) names.push(...subdirNames(skillsDir));
  }
  return names;
}

/**
 * Resolve everything the run needs for skills: the bundle dir to load as a plugin
 * (only when at least one bundled skill is on) and the explicit `skills` filter =
 * enabled bundled skills ∪ the user's plugin skills. The filter is always set
 * (even empty) so no skill from the host machine's `~/.claude` leaks into a run.
 */
export function resolveRunSkills(
  bundledState: Record<string, boolean> | null | undefined,
  userPluginPaths: string[],
): { bundleDir: string | null; skills: string[] } {
  const enabledIds = enabledBundledSkillIds(bundledState);
  const dir = bundledSkillsDir();
  const bundleDir = dir && enabledIds.length > 0 ? dir : null;
  const skills = [
    ...bundledSkillFilterNames(bundleDir ? enabledIds : []),
    ...userPluginSkillNames(userPluginPaths),
  ];
  return { bundleDir, skills };
}
