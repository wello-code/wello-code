import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app } from "electron";
import type { AppSettings } from "../shared/ipc-api";
import { defaultBundledSkillState, resolveBundledSkillState } from "../shared/bundled-skills";

/** User-editable app settings (MCP connectors, plugins, git) in userData as JSON. */
const DEFAULTS: AppSettings = {
  mcpServers: [],
  plugins: [],
  notifications: true,
  bundledSkills: defaultBundledSkillState(),
  userSkills: {},
  gitBranchPrefix: "",
  gitCommitInstructions: "",
  gitPrDraftDefault: true,
  gitPrInstructions: "",
};

/** Keep only boolean entries of a saved on/off map (defensive against hand-edits). */
function booleanMap(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

function settingsPath(): string {
  return join(app.getPath("userData"), "wello-settings.json");
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as AppSettings;
    return {
      mcpServers: Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [],
      plugins: Array.isArray(parsed.plugins) ? parsed.plugins : [],
      notifications: parsed.notifications !== false, // default on
      // Reconcile against the current catalog: newly-shipped skills take their
      // default, dropped ones fall away, every catalog skill gets an entry.
      bundledSkills: resolveBundledSkillState(parsed.bundledSkills),
      // The user's own skills: only explicit booleans survive (missing = on).
      userSkills: booleanMap(parsed.userSkills),
      gitBranchPrefix: typeof parsed.gitBranchPrefix === "string" ? parsed.gitBranchPrefix : "",
      gitCommitInstructions:
        typeof parsed.gitCommitInstructions === "string" ? parsed.gitCommitInstructions : "",
      gitPrDraftDefault: parsed.gitPrDraftDefault !== false, // default on
      gitPrInstructions:
        typeof parsed.gitPrInstructions === "string" ? parsed.gitPrInstructions : "",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

let writing = Promise.resolve();

export function saveSettings(settings: AppSettings): void {
  writing = writing.then(async () => {
    try {
      const target = settingsPath();
      await mkdir(dirname(target), { recursive: true });
      const tmp = target + ".tmp";
      await writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
      await rename(tmp, target);
    } catch {
      // Best-effort persistence.
    }
  });
}

/** Split a command-line string into argv, honoring double/single quotes. */
export function splitArgs(input: string | undefined): string[] {
  if (!input?.trim()) return [];
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    args.push(m[1] ?? m[2] ?? m[3]!);
  }
  return args;
}

/** MCP server names become tool-name segments — keep them strictly word-safe. */
export function safeMcpName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "server";
}
