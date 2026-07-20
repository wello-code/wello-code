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
