/**
 * Catalog of the skills that ship inside the app (see apps/desktop/skills-bundle).
 * Shared by the renderer (Settings toggles) and the main process (run-time
 * defaults + the `Options.skills` filter). Pure data — no node/electron imports.
 *
 * The bundle is ONE local Claude Code plugin (plugin name below); each entry's
 * `dir` is a folder under `skills-bundle/skills/`. We enable skills through the
 * SDK's explicit `skills` filter (never `'all'`), so unrelated skills that may
 * exist under the user's own `~/.claude` never leak into a run.
 */

/** plugin.json `name` in skills-bundle/.claude-plugin — the skill namespace. */
export const BUNDLED_PLUGIN_NAME = "wello-skills";

export interface BundledSkill {
  /** Stable id == the folder name under skills-bundle/skills/. */
  id: string;
  /** Russian display name for the Settings row. */
  name: string;
  /** Russian one-line description for the Settings row. */
  description: string;
  /** Provenance / license note shown as a subtle caption. */
  source: string;
  /** Whether the skill is on for a fresh install. */
  defaultEnabled: boolean;
  /** True when the skill's scripts need Python on the user's machine. */
  needsPython?: boolean;
}

/**
 * The shipped set. taste v2 is the default design skill (on out of the box, per
 * the owner's request); the Apache-2.0 skills are bundled but off by default so
 * taste v2 stays the sole design voice and the others activate only when the
 * user opts in.
 */
export const BUNDLED_SKILLS: BundledSkill[] = [
  {
    id: "design-taste-frontend",
    name: "Дизайн (taste v2)",
    description:
      "Анти-шаблонный дизайн лендингов, портфолио и редизайнов: направление, типографика, " +
      "живые интерфейсы без «дефолтного» вида. Основной дизайн-скилл.",
    source: "tasteskill (community)",
    defaultEnabled: true,
  },
  {
    id: "frontend-design",
    name: "Frontend-дизайн (Anthropic)",
    description:
      "Дополнительный гайд по осмысленному визуальному дизайну нового UI — эстетика, " +
      "типографика, отказ от шаблонных решений.",
    source: "Anthropic · Apache-2.0",
    defaultEnabled: false,
  },
  {
    id: "skill-creator",
    name: "Создание скиллов",
    description:
      "Помогает создавать, улучшать и тестировать собственные скиллы для агента.",
    source: "Anthropic · Apache-2.0",
    defaultEnabled: false,
  },
  {
    id: "mcp-builder",
    name: "Сборка MCP-серверов",
    description:
      "Гайд по созданию качественных MCP-серверов (Python FastMCP или Node/TypeScript).",
    source: "Anthropic · Apache-2.0",
    defaultEnabled: false,
  },
];

/** The default enabled-map for a fresh install (used when settings have none yet). */
export function defaultBundledSkillState(): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const s of BUNDLED_SKILLS) state[s.id] = s.defaultEnabled;
  return state;
}

/**
 * Reconcile a saved map with the current catalog: unknown ids are dropped and a
 * skill the user never saw yet takes its catalog default. Guarantees an entry for
 * every catalog skill so the UI and the run agree.
 */
export function resolveBundledSkillState(saved?: Record<string, boolean> | null): Record<string, boolean> {
  const state: Record<string, boolean> = {};
  for (const s of BUNDLED_SKILLS) {
    const v = saved?.[s.id];
    state[s.id] = typeof v === "boolean" ? v : s.defaultEnabled;
  }
  return state;
}

/** Ids of the skills that are currently on. */
export function enabledBundledSkillIds(saved?: Record<string, boolean> | null): string[] {
  const state = resolveBundledSkillState(saved);
  return BUNDLED_SKILLS.filter((s) => state[s.id]).map((s) => s.id);
}

/**
 * The names to pass to the SDK's `skills` filter for the given bundled ids. We
 * pass BOTH the bare directory name and the plugin-qualified `plugin:skill` form
 * so the match holds whether the engine lists the skill namespaced or not (an
 * unmatched name in the filter is simply ignored).
 */
export function bundledSkillFilterNames(ids: string[]): string[] {
  const names: string[] = [];
  for (const id of ids) {
    names.push(id, `${BUNDLED_PLUGIN_NAME}:${id}`);
  }
  return names;
}
