import type { PermissionCapability, RiskLevel, ToolIntent } from "@wello-code/contracts";

/** Minimal shapes we read off SDK tool_use blocks (typed defensively). */
export interface ToolUseLike {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** Classify an SDK tool by our permission capability + risk. */
export function classifyTool(name: string): { capability: PermissionCapability; risk: RiskLevel } {
  if (/^(Read|Grep|Glob|NotebookRead|LS)$/.test(name)) return { capability: "read", risk: "low" };
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return { capability: "write", risk: "medium" };
  // Plan approval — NOT a command. Classified apart so no capability grant can
  // ever cover it (probed live: the engine consults the permission callback for
  // ExitPlanMode, and a broad «command» auto-allow silently ended plan mode).
  if (name === "ExitPlanMode") return { capability: "plan", risk: "medium" };
  if (/^(Bash|BashOutput|KillShell)$/.test(name)) return { capability: "command", risk: "high" };
  if (/^(WebFetch|WebSearch)$/.test(name)) return { capability: "network", risk: "medium" };
  // The subagent tool: "Task" in older engines, "Agent" in current ones.
  if (/^(Task|Agent)$/.test(name)) return { capability: "command", risk: "low" };
  // The multi-agent orchestration tool (ultracode): spawned agents pass their own
  // tool permissions through canUseTool, so the launch itself is low-risk.
  if (name === "Workflow") return { capability: "command", risk: "low" };
  if (name.startsWith("mcp__")) return { capability: "network", risk: "medium" };
  return { capability: "command", risk: "medium" };
}

/** One-line human summary of a tool call for the timeline. */
/**
 * A failed tool_result the model routinely RECOVERS from on its own (it reads the
 * file, fixes the match, retries) → shown calmly as «повтор», not a red «ошибка».
 * Conservative allow-list: anything not matched stays a real "failed".
 */
export function classifyToolFailure(errorText: string): "recovered" | "failed" {
  const s = errorText.toLowerCase();
  const recoverable = [
    /has not been read yet|read (it|the file) first|file has not been read|read the file before/,
    /string to replace not found|to replace was not found/,
    /found \d+ matches|not unique|appears \d+ times|expected to (replace|find)/,
    /has been (modified|changed) (since|externally)|modified since read/,
    /no changes to make|are exactly the same/,
  ];
  return recoverable.some((re) => re.test(s)) ? "recovered" : "failed";
}

export function summarizeTool(name: string, input: Record<string, unknown>): string {
  switch (name) {
    // Our gateway-backed search tool (the built-in WebSearch is disallowed).
    case "mcp__wello__web_search":
      return `Поиск в интернете: ${str(input.query) ?? ""}`.trim();
    case "mcp__wello__preview_look":
      return "Смотрю на превью";
    case "mcp__wello__project_memory":
      return "Обновляю память проекта";
    // The app's GitHub bridge tools.
    case "mcp__wello__github_connect":
      return "Подключение GitHub";
    case "mcp__wello__github_create_repo":
      return `GitHub: создать репозиторий ${str(input.name) ?? ""}`.trim();
    case "Read":
      return `Read ${str(input.file_path) ?? "a file"}`;
    case "Edit":
    case "MultiEdit":
    case "Write":
      return `${name === "Write" ? "Write" : "Edit"} ${str(input.file_path) ?? "a file"}`;
    case "Bash":
      return str(input.command) ?? "Run a command";
    case "Grep":
      return `Search for ${str(input.pattern) ?? "a pattern"}`;
    case "Glob":
      return `Find ${str(input.pattern) ?? "files"}`;
    case "WebFetch":
      return `Fetch ${str(input.url) ?? "a URL"}`;
    case "ExitPlanMode":
      return "Запрос на выполнение плана";
    case "Task":
    case "Agent":
      return `Subagent · ${str(input.description) ?? str(input.subagent_type) ?? "task"}`;
    case "Workflow":
      return `Workflow · ${workflowName(input) ?? "сценарий"}`;
    default:
      return name;
  }
}

/** The workflow's name: an explicit `name`, the script's meta.name, or none. */
function workflowName(input: Record<string, unknown>): string | undefined {
  const explicit = str(input.name);
  if (explicit) return explicit;
  const script = str(input.script);
  const fromMeta = script?.match(/name\s*:\s*['"]([^'"]+)['"]/)?.[1];
  if (fromMeta) return fromMeta;
  const scriptPath = str(input.scriptPath);
  return scriptPath?.split(/[\\/]/).pop()?.replace(/\.m?js$/, "");
}

function hostOf(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

/** Map an SDK tool_use to our structured ToolIntent (best-effort, schema-valid). */
export function toToolIntent(name: string, input: Record<string, unknown>, cwd: string): ToolIntent {
  switch (name) {
    case "mcp__wello__web_search":
      return { kind: "network_request", host: "api.wello.dev", method: "POST" };
    case "mcp__wello__preview_look":
      // The pane frames a local page; "preview" names the surface, not a host.
      return { kind: "network_request", host: "preview", method: "GET" };
    case "mcp__wello__github_connect":
    case "mcp__wello__github_create_repo":
      return { kind: "network_request", host: "github.com", method: "POST" };
    case "Read":
    case "NotebookRead":
      return { kind: "read_file", paths: [str(input.file_path) ?? ""] };
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return { kind: "apply_patch", patch: "", files: [str(input.file_path) ?? ""] };
    case "Grep":
    case "Glob":
      return { kind: "search", query: str(input.pattern) ?? "", rootId: cwd };
    case "Bash":
      return { kind: "run_command", argv: [str(input.command) ?? ""], cwd };
    case "WebFetch":
    case "WebSearch":
      return { kind: "network_request", host: hostOf(str(input.url)), method: "GET" };
    default:
      return { kind: "run_command", argv: [name], cwd };
  }
}

/** Line/length caps for the permission-card edit preview: enough to judge the
 *  change, small enough to never bury the card's own buttons. */
const PREVIEW_MAX_LINES = 14;
const PREVIEW_MAX_COLS = 160;

function previewSide(text: string, sign: "-" | "+", budget: number): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const shown = lines.slice(0, budget).map((l) => `${sign} ${l.slice(0, PREVIEW_MAX_COLS)}`);
  if (lines.length > budget) shown.push(`… ещё ${lines.length - budget} строк`);
  return shown;
}

/**
 * The before/after excerpt for a file-edit permission card. Without it the card
 * said only «Изменит файл X» — approving an edit was blind. Pure and defensive:
 * returns undefined whenever there is nothing meaningful to show.
 */
export function editPreview(name: string, input: Record<string, unknown>): string | undefined {
  if (name === "Edit") {
    const oldS = str(input.old_string);
    const newS = str(input.new_string);
    if (oldS === undefined && newS === undefined) return undefined;
    const half = Math.max(2, Math.floor(PREVIEW_MAX_LINES / 2));
    const parts = [
      ...(oldS ? previewSide(oldS, "-", half) : []),
      ...(newS ? previewSide(newS, "+", half) : []),
    ];
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const first = edits[0];
    if (!first || typeof first !== "object") return undefined;
    const head = editPreview("Edit", first as Record<string, unknown>);
    if (!head) return undefined;
    return edits.length > 1 ? `${head}\n… и ещё ${edits.length - 1} правок` : head;
  }
  if (name === "Write") {
    const content = str(input.content);
    if (!content) return undefined;
    return previewSide(content, "+", PREVIEW_MAX_LINES).join("\n");
  }
  return undefined;
}

/** Concrete impact lines shown on the permission card (in the user's language). */
export function describeImpact(name: string, input: Record<string, unknown>): string[] {
  if (name === "mcp__wello__web_search") {
    return [`Выполнит веб-поиск: «${str(input.query) ?? ""}» (через шлюз Wello).`];
  }
  if (name === "mcp__wello__github_create_repo") {
    const priv = input.private !== false;
    return [
      `Создаст ${priv ? "приватный" : "ПУБЛИЧНЫЙ"} репозиторий «${str(input.name) ?? "?"}» в вашем GitHub.`,
      "Привяжет его к проекту (origin) и отправит туда текущий код.",
    ];
  }
  const { capability } = classifyTool(name);
  switch (capability) {
    case "read":
      return [`Прочитает ${str(input.file_path) ?? "файлы проекта"}.`];
    case "write":
      return [`Изменит ${str(input.file_path) ?? "файл"} в проекте.`];
    case "command":
      return [`Выполнит: ${str(input.command) ?? name}`];
    case "network":
      return [`Обратится к ${hostOf(str(input.url))} по сети.`];
    default:
      return [`Запустит инструмент ${name}.`];
  }
}
