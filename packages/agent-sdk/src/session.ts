import { randomUUID } from "node:crypto";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  EffortLevel,
  Options,
  PermissionMode,
  SDKMessage,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  parseAgentEvent,
  type AgentEvent,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionScope,
  type Question,
  type QuestionAnswer,
  type QuestionRequest,
  type TaskMode,
  type ToolCall,
} from "@wello-code/contracts";
import {
  classifyTool,
  classifyToolFailure,
  describeImpact,
  summarizeTool,
  toToolIntent,
} from "./tool-map";
import { formatWebSearchHits, gatewayWebSearch } from "./web-search";

const WELLO_BASE_URL = "https://api.wello.dev";

/**
 * The gateway's /code API base (phase 2): same Anthropic passthrough as the
 * dev-API, but billed SUBSCRIPTION-FIRST (plan windows, then PAYG overflow).
 * The engine appends /v1/messages itself, so the base just gains the prefix.
 */
function codeApiBase(baseUrl: string | undefined): string {
  return `${baseUrl ?? WELLO_BASE_URL}/code`;
}

/** Our in-process MCP server + the fully-qualified name the model calls. */
const ASK_SERVER = "wello";
const ASK_TOOL = "ask_user";
export const ASK_TOOL_FQN = `mcp__${ASK_SERVER}__${ASK_TOOL}`;

/**
 * Our web-search tool (same in-process server). The engine's own WebSearch is a
 * server-side Anthropic tool that the Wello /code passthrough cannot serve
 * (probed live 2026-07-18: every call returns "400 Upstream error"), so it is
 * disallowed and replaced by this gateway-backed search. WebFetch (a local
 * fetcher inside the engine binary) works and stays available.
 */
const WEB_SEARCH_TOOL = "web_search";
export const WEB_SEARCH_TOOL_FQN = `mcp__${ASK_SERVER}__${WEB_SEARCH_TOOL}`;

/**
 * The app's GitHub bridge as agent tools (same in-process server): connect via
 * the one-click chat card, and create-repo-and-publish through the stored
 * token. They exist so the model NEVER sends a novice to `gh auth login` or
 * github.com/new — the app owns the whole flow.
 */
const GITHUB_CONNECT_TOOL = "github_connect";
export const GITHUB_CONNECT_TOOL_FQN = `mcp__${ASK_SERVER}__${GITHUB_CONNECT_TOOL}`;
const GITHUB_CREATE_REPO_TOOL = "github_create_repo";
export const GITHUB_CREATE_REPO_TOOL_FQN = `mcp__${ASK_SERVER}__${GITHUB_CREATE_REPO_TOOL}`;

/**
 * Engine bookkeeping tools that touch nothing on the machine (planning/todo
 * state) — never worth a permission card. NOT ExitPlanMode: leaving plan mode is
 * a real decision the user should approve. Two generations of names: the old
 * TodoWrite/TodoRead pair and the current Task* registry (probed live
 * 2026-07-18 — engine 0.3.207 models reach for TaskCreate/TaskUpdate).
 */
const SAFE_ENGINE_TOOLS = new Set([
  "TodoWrite",
  "TodoRead",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

/** Plain-language "why" shown on the permission card, per capability (RU UI). */
const PERMISSION_REASON: Record<string, string> = {
  read: "Агент хочет прочитать файлы проекта.",
  write: "Агент хочет изменить файлы в проекте.",
  command: "Агент хочет выполнить команду на вашем компьютере.",
  git: "Агент хочет выполнить операцию Git.",
  network: "Агент хочет обратиться в интернет.",
  external_url: "Агент хочет открыть внешнюю ссылку.",
  delete: "Агент хочет удалить файлы.",
};

/**
 * Turn a raw engine/gateway error into a friendly Russian message plus a code the
 * UI can branch on. Balance exhaustion is NOT retryable — retrying just fails again
 * (the user must top up), so the UI hides "retry" and offers a top-up link instead.
 */
function classifyFailure(raw: string): { code: string; message: string; retryable: boolean } {
  const s = raw.toLowerCase();
  // Monthly subscription cap exhausted (the /code API bills the plan first) — checked
  // BEFORE the generic 402 branch, which would otherwise swallow it as "top up".
  // The cap resets when the subscription renews, so the copy says so.
  if (/subscription_cap|subscription limit/.test(s)) {
    return {
      code: "subscription_limit",
      message:
        "Месячный лимит подписки исчерпан. Он сбросится при продлении подписки, либо " +
        "включите оплату сверх лимита (PAYG) в настройках Wello.",
      retryable: false,
    };
  }
  if (/402|payment required|prepaid balance|balance too low|insufficient|недостаточно средств/.test(s)) {
    return {
      code: "insufficient_balance",
      message: "На балансе Wello закончились средства. Пополните счёт, чтобы продолжить.",
      retryable: false,
    };
  }
  if (/fetch failed|enotfound|econnrefused|econnreset|etimedout|und_err|getaddrinfo|socket hang|network error|dns/.test(s)) {
    return {
      code: "offline",
      message: "Нет связи с Wello. Проверьте интернет-соединение и повторите.",
      retryable: true,
    };
  }
  return {
    code: "runtime_error",
    message: "Во время работы произошла ошибка. Попробуйте ещё раз.",
    retryable: true,
  };
}

/**
 * Steers the model to our interactive question tool. The built-in AskUserQuestion
 * is disabled because it silently no-ops in a headless subprocess (no TTY), which
 * makes the agent guess instead of asking.
 */
const ASK_SYSTEM_APPEND = [
  "When you need information only the user can provide — missing requirements, a real",
  `choice between valid options, or ambiguous scope — call the \`${ASK_TOOL}\` tool with`,
  "one to three short questions (2–4 options each) INSTEAD of guessing or assuming",
  "defaults. Ask early, before doing significant work. Write the questions and options",
  "in the same language the user is writing in. Set multiSelect:true on any question",
  "where several options could apply at once (areas to touch, features to include);",
  "keep it single-choice only for a genuine one-of decision. Skip the tool for trivial",
  "decisions you can safely make yourself.",
].join(" ");

/**
 * Teaches the model WHEN to delegate to subagents (the Agent tool) — the preset
 * doesn't cover it, and un-steered models either never delegate or delegate
 * everything. Subagents are pinned to the user's chosen model (see buildEnv).
 *
 * ⚠️ A specialist-team experiment (per-role cheap models via Options.agents) was
 * REVERTED after live trials: with prompt-tuned roles it cost about the same as
 * this simple shape, while adding coordination overhead and failure modes (DIY
 * preprocessing, bureaucratic one-page agents). The engine's own delegation with
 * same-model subagents is already well-tuned. Re-visit ONLY with a genuinely
 * cheap model in the catalog AND a fixed skill recipe.
 */
const SUBAGENT_SYSTEM_APPEND = [
  "Subagents (the Agent tool) run on the same model as you — delegating never trades",
  "away quality. Delegate when it genuinely helps: (1) broad exploration — understanding",
  "an unfamiliar codebase, finding usages across many files, sweeping searches where you",
  "only need the conclusion, not the file dumps; (2) several independent subtasks —",
  "spawn one agent per subtask in a single turn so they run in parallel; (3) research or",
  "verification passes whose intermediate output would flood your context — the subagent",
  "reads everything and returns only its findings. Do the work yourself when it is a",
  "single-file read or edit, a small sequential change, or you already know exactly",
  "where to look — a subagent there only adds latency. Never delegate the final",
  "user-facing answer, and do not override a subagent's model.",
].join(" ");

/**
 * Points the model at our search tool (the built-in WebSearch is disallowed —
 * see WEB_SEARCH_TOOL). Without this note models raised on the Claude Code
 * preset keep reaching for WebSearch and conclude the web is unavailable.
 */
const WEB_SEARCH_SYSTEM_APPEND = [
  "The built-in WebSearch tool is BROKEN in this environment (its backend upstream-errors",
  `on every call) — never call WebSearch. For any web lookup call \`${WEB_SEARCH_TOOL}\``,
  "instead: it is this environment's working, sanctioned search (not a workaround).",
  "Follow up with WebFetch to read a specific page from the results in full.",
].join(" ");

/**
 * Teaches the model this app's GitHub story — the #1 novice trap seen live was
 * the model sending users to `gh auth login` / github.com/new while the app has
 * its own Device Flow auth and repo tools. The wording depends on whether
 * GitHub is connected at run start AND whether the credential bridge actually
 * rides this run's env (`pushAuthed`) — untrusted folders never get the token,
 * so there git must go through the tools, which push app-side.
 */
export function githubSystemAppend(
  github?: { connected: boolean; login?: string },
  pushAuthed = false,
): string {
  const common = [
    `NEVER tell the user to run \`gh auth login\`, install the gh CLI, create tokens/SSH keys,`,
    "or create a repository by hand on github.com — this app has its own built-in GitHub",
    "integration and those instructions only strand non-technical users. The gh CLI may be",
    "missing or unauthenticated here; do not rely on it.",
  ].join(" ");
  if (github?.connected && pushAuthed) {
    return [
      `GitHub is CONNECTED in this app${github.login ? ` as "${github.login}"` : ""}.`,
      "git push/pull/fetch to github.com are ALREADY AUTHENTICATED (the app injects a",
      "scoped credential helper with the user's token) — just run git normally. To publish",
      `a project that has no GitHub repository yet, call \`${GITHUB_CREATE_REPO_TOOL}\`: it`,
      "creates the repo under the user's account, attaches it as `origin` and pushes the",
      "current branch in one step (commit first if there is nothing committed).",
      common,
    ].join(" ");
  }
  if (github?.connected) {
    return [
      `GitHub is CONNECTED in this app${github.login ? ` as "${github.login}"` : ""}, but`,
      "plain `git push` is NOT authenticated in this restricted folder. Publish and push",
      `through \`${GITHUB_CREATE_REPO_TOOL}\` instead — it creates the repo, attaches`,
      "`origin` and pushes THROUGH THE APP, so it works here.",
      common,
    ].join(" ");
  }
  return [
    "GitHub is NOT connected in this app yet. When the task needs GitHub (publish/push/",
    `pull requests), FIRST call \`${GITHUB_CONNECT_TOOL}\`: the user gets a one-click connect`,
    "card right in the chat and the tool waits for the outcome — that is the ONLY correct",
    `way to get GitHub access here. After it succeeds, use \`${GITHUB_CREATE_REPO_TOOL}\` to`,
    "create-and-publish the repository (it pushes through the app and works immediately).",
    "Plain `git push` becomes authenticated from the NEXT user message onward — inside the",
    "same turn rely on the tool's built-in push instead of running `git push` yourself.",
    common,
  ].join(" ");
}

const SYSTEM_APPEND = `${ASK_SYSTEM_APPEND}\n\n${SUBAGENT_SYSTEM_APPEND}\n\n${WEB_SEARCH_SYSTEM_APPEND}`;

/**
 * The «Ультра» mode is the engine's NATIVE ultracode mechanism, switched on via
 * the flag-settings layer (probed live 2026-07-14 through the Wello gateway):
 * the engine injects its own standing directive («Ultracode is on: … use the
 * Workflow tool on every substantive task») and the Workflow orchestration tool
 * scripts agent()/parallel()/pipeline() fleets. No prompt-side directive of ours
 * is needed anymore — the old ULTRA_SYSTEM_APPEND is retired in favor of this.
 * `enableWorkflows` is set explicitly because its default is plan-gated.
 */
const ULTRA_SETTINGS: Settings = { ultracode: true, enableWorkflows: true };

/** The UI's effort scale: the engine's five levels plus our «Ультра» position. */
export type WelloEffort = EffortLevel | "ultra";

/**
 * Catalog models the engine window-tables treat as 200K by default, while the
 * Wello upstream actually serves their native 1M window (probed live 2026-07-14:
 * a 480K-token prompt went through end-to-end). Passing the engine's "[1m]"
 * model variant makes its context gauge and auto-compaction use the real window;
 * the suffix is engine-internal — API requests still carry the clean model id.
 */
const MODELS_1M = new Set(["claude-sonnet-5", "claude-opus-4-8", "claude-fable-5"]);

/** The id handed to the engine: 1M-class models ride the "[1m]" variant. */
export function engineModelId(model: string): string {
  return MODELS_1M.has(model) ? `${model}[1m]` : model;
}

/**
 * Explicit thinking-token budgets for the top effort positions. On xhigh/max (and
 * the xhigh-based «Ультра») the engine's raw `effort` param drives Opus into a
 * NON-TERMINATING thinking phase whenever a large skill lands in context — the
 * default design skill is ~1.2k lines, and the model reasons over it without ever
 * stopping. The Wello upstream never streams thinking, so the UI just sat on
 * «Думает…» for 10+ minutes (owner-reported 2026-07-24; reproduced live: max/xhigh
 * spiral, high and below terminate on their own in ~1 min). `effort` guides adaptive
 * thinking depth and OVERRIDES `maxThinkingTokens`, so the only way to bound these
 * levels is to drop `effort` and hand the engine an explicit `thinking` budget — a
 * hard ceiling the model must stop at, so the turn always terminates. The budgets
 * stay generous (deep reasoning is the whole point of the top of the scale) but
 * finite. low/medium/high reason and stop by themselves, so they keep the native
 * `effort` param untouched — the common path (high is the default) is unchanged.
 */
const TOP_THINKING_BUDGET: Partial<Record<WelloEffort, number>> = {
  xhigh: 32_000,
  max: 48_000,
  ultra: 48_000,
};

/**
 * UI effort → what the engine gets. low/medium/high pass through as the native
 * `effort` param (fast, well-tuned, and self-terminating). xhigh/max/«Ультра» run
 * on a bounded `thinking` budget INSTEAD of `effort` — see TOP_THINKING_BUDGET for
 * why: raw high-tier effort overthinks skill-heavy turns forever. «Ультра» also
 * flips the native ultracode orchestration flag on (its budget matches max).
 */
export function resolveEffort(effort?: WelloEffort): {
  engineEffort?: EffortLevel;
  thinkingBudget?: number;
  ultra: boolean;
} {
  if (effort === "ultra") return { thinkingBudget: TOP_THINKING_BUDGET.ultra, ultra: true };
  const budget = effort ? TOP_THINKING_BUDGET[effort] : undefined;
  if (budget) return { thinkingBudget: budget, ultra: false };
  return { engineEffort: effort, ultra: false };
}

/** One workflow agent as carried by our workflow.progress event. */
export interface WorkflowAgentProgress {
  id: string;
  label?: string;
  phase?: string;
  model?: string;
  state: string;
  promptPreview?: string;
  resultPreview?: string;
  tokens?: number;
  startedAt?: number;
  updatedAt?: number;
}

/**
 * Extract the workflow roster from a raw engine `task_progress` frame. The frame
 * carries a FULL `workflow_progress` snapshot (phases + agents) on every tick;
 * we forward only the agents — phase titles ride along on each agent. Returns
 * null for non-workflow progress (e.g. a plain background Agent task).
 */
export function workflowProgressAgents(raw: unknown): WorkflowAgentProgress[] | null {
  if (!raw || typeof raw !== "object") return null;
  const entries = (raw as { workflow_progress?: unknown }).workflow_progress;
  if (!Array.isArray(entries)) return null;
  const agents: WorkflowAgentProgress[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== "workflow_agent") continue;
    const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;
    agents.push({
      id: str(e.agentId) ?? String(num(e.index) ?? agents.length),
      label: str(e.label),
      phase: str(e.phaseTitle),
      model: str(e.model),
      state: str(e.state) ?? "start",
      promptPreview: str(e.promptPreview),
      resultPreview: str(e.resultPreview),
      tokens: num(e.tokens),
      startedAt: num(e.startedAt),
      updatedAt: num(e.lastProgressAt),
    });
  }
  return agents.length > 0 ? agents : null;
}

/** Credential + endpoint for the Wello gateway (the SDK's model backend). */
export interface WelloConnection {
  apiKey: string;
  baseUrl?: string;
}

export interface SdkRunRequest {
  taskId: string;
  runId: string;
  workspaceId: string;
  /** Canonical absolute path of the opened workspace — the agent's cwd. */
  workspacePath: string;
  mode: TaskMode;
  prompt: string;
  /** Wello catalog model id (e.g. "claude-sonnet-5"). Defaults to Sonnet. */
  model?: string;
  /** Reasoning effort: low → max, plus "ultra" (= xhigh + subagent orchestration). */
  effort?: WelloEffort;
  /** Resume this engine session (follow-up turn in the same task). */
  resumeSessionId?: string;
  /**
   * "Edit this turn": resume only up to this engine message uuid and FORK into a
   * fresh session id (the original stays intact). Requires resumeSessionId.
   */
  resumeAtMessageUuid?: string;
  /** User-configured MCP servers (stdio command or remote url), by name. */
  mcpServers?: Record<
    string,
    { command: string; args?: string[] } | { type: "sse" | "http"; url: string }
  >;
  /** Local plugin/skill directories to load into the engine. */
  pluginPaths?: string[];
  /**
   * Explicit skill allow-list for `Options.skills` (bundled + user-plugin skills).
   * Always set by the runtime (may be empty) so skills from the host machine's
   * `~/.claude` are never auto-enabled into a run. Undefined = no filter.
   */
  skills?: string[];
  /**
   * Extra directories the engine may access without a permission ask (e.g. the
   * app-owned folder with pasted screenshots the model opens via Read).
   */
  additionalDirectories?: string[];
  /**
   * Whether the user trusts this workspace. Trusted folders load PROJECT-level
   * settings (CLAUDE.md, .claude/settings, project commands/skills/hooks) and
   * honor persisted workspace grants; untrusted ones run fully isolated
   * (`settingSources: []`) and never offer «Разрешить для проекта».
   */
  trusted?: boolean;
  /** Capabilities previously granted with «Разрешить для проекта» (trusted only). */
  workspaceGrants?: string[];
  /**
   * Project instructions the runtime injects itself (AGENTS.md — the engine only
   * loads CLAUDE.md natively). Trusted workspaces only; appended to the system
   * prompt as data from the repo.
   */
  projectInstructions?: { file: string; content: string };
  /**
   * GitHub connection status at run start — picks the system-prompt wording
   * (connected: "git push just works"; not: "call github_connect first").
   */
  github?: { connected: boolean; login?: string };
  /**
   * Extra env for the engine subprocess: the app's git credential bridge, so
   * every `git push/pull/fetch` the agent runs against github.com authenticates
   * with the user's stored token (set only when GitHub is connected).
   */
  gitEnv?: Record<string, string>;
}

/** What the github_create_repo tool reports back to the model (runtime-mapped). */
export interface GithubPublishOutcome {
  ok: boolean;
  url?: string;
  fullName?: string;
  pushed?: boolean;
  error?: string;
  nameTaken?: boolean;
}

export interface AgentRunCallbacks {
  /** Every mapped, schema-valid AgentEvent for the timeline/audit. */
  onEvent(event: AgentEvent): void;
  /** Await the user's decision for a pending tool permission. */
  requestPermission(request: PermissionRequest): Promise<PermissionDecision>;
  /** Await the user's answer to a model-initiated clarifying question. */
  requestQuestion(request: QuestionRequest): Promise<QuestionAnswer>;
  /** The user granted a capability for the whole workspace — persist it. */
  onWorkspaceGrant?(capability: string): void;
  /**
   * github_connect: a connect card was shown (the runtime emitted the event);
   * resolves once the user finished/declined the Device Flow — or the run ends.
   */
  requestGithubConnect?(request: { id: string; runId: string }): Promise<{
    connected: boolean;
    login?: string;
  }>;
  /** github_create_repo: create → attach origin → push, via the app's token. */
  createGithubRepo?(input: {
    name: string;
    private: boolean;
    description?: string;
  }): Promise<GithubPublishOutcome>;
  /** Optional stderr sink from the Claude Code subprocess (debugging). */
  onLog?(line: string): void;
}

/** Loose views over SDK message content (typed defensively to avoid deep SDK types). */
interface TextBlock {
  type: "text";
  text: string;
}
interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content?: string | Array<{ type: string; text?: string }>;
}

/** Flatten a tool_result's content to plain text (for failure classification). */
export function toolResultErrorText(block: {
  content?: string | Array<{ type: string; text?: string }>;
}): string {
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p) => p.text ?? "").join(" ");
  return "";
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string };

interface StreamEventLike {
  type: string;
  delta?: { type?: string; text?: string };
}

/**
 * Per-run mapping state. Background subagents AND workflows get an immediate
 * "launched" ack as their tool_result (the engine runs the Agent/Workflow tools
 * async by default) — the real settle arrives later as a system
 * `task_notification`. The map correlates its task_id back to the launching
 * tool_use id; `result` holds the terminal frame so the run completes once,
 * after the stream closes (a stream with background tasks carries one result
 * frame per notification mini-turn, not just one).
 */
interface RunMapState {
  asyncTasks: Map<string, string>;
  result: { ok: true; summary: string } | { ok: false; code: string } | null;
  /**
   * The run's live plan, rebuilt from the engine's task registry (TaskCreate /
   * TaskUpdate — TaskCreate's id only arrives in its tool_result, so creates
   * park in `pendingCreates` until it lands). Order = creation order.
   */
  plan: {
    order: string[];
    byId: Map<string, { text: string; status: "pending" | "in_progress" | "completed" }>;
    pendingCreates: Map<string, string>;
  };
}

/** The engine's tool_result for TaskCreate names the new id: "Task #7 created…". */
export function taskIdFromCreateResult(text: string): string | null {
  const m = /Task\s+#?(\d+)\b/i.exec(text);
  return m ? m[1]! : null;
}

/** Current plan snapshot for a plan.updated event (creation order). */
function planItems(plan: RunMapState["plan"]): Array<{ text: string; status: "pending" | "in_progress" | "completed" }> {
  return plan.order
    .map((id) => plan.byId.get(id))
    .filter((x): x is { text: string; status: "pending" | "in_progress" | "completed" } => Boolean(x));
}

/**
 * The full todo list from a TodoWrite tool input (the engine sends the WHOLE
 * list on every call). Defensive: malformed entries are dropped; null when the
 * input carries no usable list at all.
 */
export function todosFromToolInput(
  input: Record<string, unknown>,
): Array<{ text: string; status: "pending" | "in_progress" | "completed" }> | null {
  const raw = input.todos;
  if (!Array.isArray(raw)) return null;
  const items: Array<{ text: string; status: "pending" | "in_progress" | "completed" }> = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const text =
      typeof e.content === "string" && e.content.trim()
        ? e.content.trim()
        : typeof e.activeForm === "string" && e.activeForm.trim()
          ? e.activeForm.trim()
          : "";
    if (!text) continue;
    const status =
      e.status === "in_progress" || e.status === "completed" ? e.status : ("pending" as const);
    items.push({ text: text.slice(0, 300), status });
  }
  return items;
}

/**
 * Tokens occupying the context window after an assistant turn: fresh input +
 * cache reads/writes + the answer itself. Null when the message carries no usage.
 */
export function contextTokensFromUsage(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  const total =
    n(u.input_tokens) +
    n(u.cache_creation_input_tokens) +
    n(u.cache_read_input_tokens) +
    n(u.output_tokens);
  return total > 0 ? total : null;
}

/**
 * Points the Claude Agent SDK at the Wello gateway and translates its message
 * stream into our typed AgentEvents. The SDK spawns the bundled `claude` binary;
 * all model traffic is routed to Wello via ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
 * (the subprocess env REPLACES process.env, so we spread it and override the auth).
 */
export class SdkAgentSession {
  private readonly conn: WelloConnection;

  constructor(conn: WelloConnection) {
    this.conn = conn;
  }

  private buildEnv(model: string, gitEnv?: Record<string, string>): Record<string, string | undefined> {
    return {
      ...process.env,
      // The GitHub credential bridge (github.com-scoped helper + token) — every
      // git the agent spawns pushes/pulls as the connected account. The token is
      // the user's own and stays out of argv/config values (env only).
      ...(gitEnv ?? {}),
      ANTHROPIC_BASE_URL: codeApiBase(this.conn.baseUrl),
      ANTHROPIC_AUTH_TOKEN: this.conn.apiKey,
      // Force the Bearer scheme (gateway key), never the first-party x-api-key path.
      ANTHROPIC_API_KEY: undefined,
      // Every subagent (built-in Explore/Plan/general-purpose or custom) runs on the
      // model the user picked — built-ins inherit anyway, this closes the gaps
      // (per-invocation overrides, engine defaults on unknown gateway model ids).
      CLAUDE_CODE_SUBAGENT_MODEL: model,
      CLAUDE_AGENT_SDK_CLIENT_APP: "wello-code/0.0.0",
    };
  }

  async run(req: SdkRunRequest, callbacks: AgentRunCallbacks, signal: AbortSignal): Promise<void> {
    const correlationId = randomUUID();
    const emit = (type: string, data: unknown): void => {
      callbacks.onEvent(
        parseAgentEvent({
          id: randomUUID(),
          schemaVersion: 1,
          type,
          timestamp: new Date().toISOString(),
          correlationId,
          taskId: req.taskId,
          runId: req.runId,
          data,
        }),
      );
    };

    const allowedReadRoots = (req.additionalDirectories ?? []).map(normalizeDirPrefix);
    // Capabilities the user chose "allow for this task" on — honored for the rest
    // of the run so a coding session doesn't re-prompt on every edit/command.
    const grantedCaps = new Set<string>();
    // Capabilities granted «для проекта» in EARLIER runs (persisted per workspace;
    // only trusted folders carry them — the runtime passes [] otherwise).
    const workspaceCaps = new Set(req.workspaceGrants ?? []);
    const canUseTool: CanUseTool = async (toolName, input) => {
      // Our own question tool is not a privileged action — it just asks the user.
      // Never gate it behind a permission card.
      if (toolName === ASK_TOOL_FQN) return { behavior: "allow", updatedInput: input };
      // The connect tool only SHOWS a card — the user decides there; no extra gate.
      if (toolName === GITHUB_CONNECT_TOOL_FQN) return { behavior: "allow", updatedInput: input };
      // Creating a repo in the user's GitHub account is a real outward action —
      // its own permission card spells out exactly what will be created.
      if (toolName === GITHUB_CREATE_REPO_TOOL_FQN) {
        const repoName = typeof input.name === "string" ? input.name : "?";
        const isPrivate = input.private !== false;
        const permReq: PermissionRequest = {
          id: randomUUID(),
          runId: req.runId,
          intentId: randomUUID(),
          capability: "network",
          risk: "high",
          reason: "Агент хочет создать репозиторий в вашем GitHub.",
          impact: [
            `Создаст ${isPrivate ? "приватный" : "ПУБЛИЧНЫЙ"} репозиторий «${repoName}» в вашем аккаунте GitHub.`,
            "Привяжет его к проекту (origin) и отправит туда текущий код.",
          ],
          scope: { workspaceId: req.workspaceId, host: "github.com" },
          allowedDecisions: ["allow_once", "deny"],
        };
        emit("permission.requested", permReq);
        const decision = await callbacks.requestPermission(permReq);
        if (decision === "deny") return { behavior: "deny", message: "The user denied this action." };
        return { behavior: "allow", updatedInput: input };
      }
      // Pure planning/bookkeeping tools change nothing on the machine.
      if (SAFE_ENGINE_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: input };
      const { capability, risk } = classifyTool(toolName);
      // Reading inside an app-owned whitelisted folder (pasted screenshots) never
      // needs a card: the engine's own additionalDirectories check can miss when
      // path forms differ (e.g. Windows 8.3 short names), so we decide here too.
      if (capability === "read" && allowedReadRoots.length > 0) {
        const target = typeof input.file_path === "string" ? input.file_path : undefined;
        if (target && pathInsideRoots(target, allowedReadRoots)) {
          return { behavior: "allow", updatedInput: input };
        }
      }
      // A prior "allow for this task/workspace" on this capability skips the card.
      if (grantedCaps.has(capability) || workspaceCaps.has(capability)) {
        return { behavior: "allow", updatedInput: input };
      }
      const permReq: PermissionRequest = {
        id: randomUUID(),
        runId: req.runId,
        intentId: randomUUID(),
        capability,
        risk,
        reason: PERMISSION_REASON[capability] ?? "Агент запрашивает разрешение на действие.",
        impact: describeImpact(toolName, input),
        scope: buildScope(req.workspaceId, req.workspacePath, input),
        // Critical actions never get persistent grants; the workspace-wide grant
        // is offered only in folders the user explicitly trusts.
        allowedDecisions:
          risk === "critical"
            ? ["allow_once", "deny"]
            : req.trusted
              ? ["allow_once", "allow_for_task", "allow_for_workspace", "deny"]
              : ["allow_once", "allow_for_task", "deny"],
      };
      emit("permission.requested", permReq);
      const decision = await callbacks.requestPermission(permReq);
      if (decision === "deny") return { behavior: "deny", message: "The user denied this action." };
      // Remember a task/workspace grant so matching later calls don't re-prompt.
      if (decision === "allow_for_task" || decision === "allow_for_workspace") {
        grantedCaps.add(capability);
      }
      // A workspace grant also persists for the folder's future runs.
      if (decision === "allow_for_workspace") callbacks.onWorkspaceGrant?.(capability);
      return { behavior: "allow", updatedInput: input };
    };

    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    if (signal.aborted) abort.abort();
    else signal.addEventListener("abort", onAbort, { once: true });

    // In-process tool the model calls to ask the user a real question. Its handler
    // surfaces the question to the UI and blocks on the answer, which becomes the
    // tool result the model reads.
    const askServer = createSdkMcpServer({
      name: ASK_SERVER,
      version: "1.0.0",
      tools: [
        tool(
          ASK_TOOL,
          "Ask the user one or more clarifying questions with predefined options when you " +
            "need information only they can provide. Returns their selected answers.",
          {
            questions: z
              .array(
                z.object({
                  header: z.string().describe("Short 1–2 word topic label for the question."),
                  question: z.string().describe("The full question, in the user's language."),
                  multiSelect: z
                    .boolean()
                    .optional()
                    .describe(
                      "Set TRUE whenever the user could reasonably pick MORE THAN ONE option " +
                        "(e.g. which areas/features/causes apply, what to include). Only leave " +
                        "false/omitted for a genuinely single-choice question (one direction, " +
                        "yes/no, pick the single best). When in doubt and several answers could " +
                        "co-apply, prefer true.",
                    ),
                  options: z
                    .array(
                      z.object({
                        label: z.string(),
                        description: z.string().optional(),
                      }),
                    )
                    .min(2)
                    .max(4)
                    .describe("2–4 mutually distinct choices."),
                }),
              )
              .min(1)
              .max(3),
          },
          async (args) => {
            const request: QuestionRequest = {
              id: randomUUID(),
              runId: req.runId,
              questions: (args.questions as Question[]).map((q) => ({
                header: q.header,
                question: q.question,
                multiSelect: q.multiSelect ?? false,
                options: q.options,
              })),
            };
            emit("question.requested", request);
            const answer = await callbacks.requestQuestion(request);
            return { content: [{ type: "text", text: formatAnswer(request, answer) }] };
          },
        ),
        tool(
          WEB_SEARCH_TOOL,
          "Search the web for current information. Returns titles, URLs and snippets; " +
            "use WebFetch afterwards to read a specific page in full.",
          {
            query: z.string().min(1).max(400).describe("The search query."),
          },
          async (args) => {
            const outcome = await gatewayWebSearch(
              codeApiBase(this.conn.baseUrl),
              this.conn.apiKey,
              String(args.query),
            );
            if (!outcome.ok) {
              return { content: [{ type: "text", text: outcome.error }], isError: true };
            }
            return {
              content: [{ type: "text", text: formatWebSearchHits(String(args.query), outcome.hits) }],
            };
          },
        ),
        tool(
          GITHUB_CONNECT_TOOL,
          "Connect the user's GitHub account to this app: shows a one-click connect card in " +
            "the chat and waits for the user to finish (or decline). Call this when a task " +
            "needs GitHub and it is not connected — never send the user to gh auth login.",
          {},
          async () => {
            if (!callbacks.requestGithubConnect) {
              return {
                content: [{ type: "text", text: "GitHub integration is unavailable in this build." }],
                isError: true,
              };
            }
            const result = await callbacks.requestGithubConnect({ id: randomUUID(), runId: req.runId });
            if (!result.connected) {
              return {
                content: [
                  {
                    type: "text",
                    text:
                      "The user declined to connect GitHub (or closed the card). Do not retry " +
                      "immediately — continue without GitHub or ask how they want to proceed.",
                  },
                ],
              };
            }
            return {
              content: [
                {
                  type: "text",
                  text:
                    `GitHub is now connected as "${result.login ?? "?"}". Use ` +
                    `${GITHUB_CREATE_REPO_TOOL} to create-and-publish a repository (it pushes ` +
                    "through the app and works right away). Plain `git push` becomes " +
                    "authenticated from the NEXT user message — within this turn rely on the " +
                    "tool's built-in push instead of running git push yourself.",
                },
              ],
            };
          },
        ),
        tool(
          GITHUB_CREATE_REPO_TOOL,
          "Create a GitHub repository under the connected user's account, attach it as " +
            "`origin` and push the current branch — the standard way to publish this project " +
            "to GitHub. Commit local changes first; requires GitHub connected (github_connect).",
          {
            name: z
              .string()
              .min(1)
              .max(100)
              .describe("Repository name (ASCII letters/digits/._- ; GitHub dash-normalizes the rest)."),
            private: z
              .boolean()
              .optional()
              .describe("Private repository (DEFAULT true). Only pass false when the user explicitly asked for a public repo."),
            description: z.string().max(300).optional().describe("Short repository description."),
          },
          async (args) => {
            if (!callbacks.createGithubRepo) {
              return {
                content: [{ type: "text", text: "GitHub integration is unavailable in this build." }],
                isError: true,
              };
            }
            const res = await callbacks.createGithubRepo({
              name: String(args.name),
              private: args.private !== false,
              ...(args.description ? { description: String(args.description) } : {}),
            });
            if (!res.ok) {
              const hint = res.nameTaken
                ? " Pick a different repository name and call the tool again."
                : "";
              return {
                content: [{ type: "text", text: `Failed: ${res.error ?? "unknown error"}.${hint}` }],
                isError: true,
              };
            }
            const pushNote = res.pushed
              ? "The current branch is pushed — the code is on GitHub."
              : "The repository is created and attached as `origin`, but nothing is pushed yet" +
                (res.error ? ` (${res.error})` : "") +
                " — commit, then push with `git push -u origin HEAD`.";
            return {
              content: [
                {
                  type: "text",
                  text: `Repository ${res.fullName ?? ""} created: ${res.url ?? ""}. ${pushNote}`,
                },
              ],
            };
          },
        ),
      ],
    });

    const permissionMode = sdkPermissionMode(req.mode);
    const model = engineModelId(req.model ?? "claude-sonnet-5");
    const { engineEffort, thinkingBudget, ultra } = resolveEffort(req.effort);
    // Self-injected project instructions (AGENTS.md): the engine only loads
    // CLAUDE.md natively, so the runtime reads AGENTS.md and appends it here.
    const baseAppend = `${SYSTEM_APPEND}\n\n${githubSystemAppend(req.github, Boolean(req.gitEnv))}`;
    const systemAppend = req.projectInstructions
      ? `${baseAppend}\n\nProject instructions from ${req.projectInstructions.file} ` +
        `(checked into this repository):\n${req.projectInstructions.content}`
      : baseAppend;
    const options: Options = {
      cwd: req.workspacePath,
      model,
      // Top of the scale rides a bounded `thinking` budget instead of raw
      // `effort` (which overthinks skill-heavy turns forever) — see resolveEffort.
      // Exactly one of these is set; they are mutually exclusive.
      ...(engineEffort ? { effort: engineEffort } : {}),
      ...(thinkingBudget
        ? { thinking: { type: "enabled" as const, budgetTokens: thinkingBudget } }
        : {}),
      env: this.buildEnv(model, req.gitEnv),
      abortController: abort,
      includePartialMessages: true,
      // Full subagent conversations (text with parent_tool_use_id) feed the
      // nested transcripts in the Subagents panel.
      forwardSubagentText: true,
      // Trusted workspaces get the full Claude Code experience: CLAUDE.md,
      // .claude/settings(.local).json, project commands/skills/hooks. Untrusted
      // ones stay isolated — repo-supplied settings are an RCE surface (hooks,
      // permission allow-lists), so nothing project-level loads before the user
      // trusts the folder. The 'user' source (host ~/.claude) is never loaded.
      settingSources: req.trusted ? ["project", "local"] : [],
      ...(ultra ? { settings: ULTRA_SETTINGS } : {}),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: systemAppend,
      },
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      ...(req.resumeSessionId ? { resume: req.resumeSessionId } : {}),
      // Edit-a-turn: load the conversation only up to the anchor message and
      // fork to a new session id — the pre-edit history stays untouched.
      ...(req.resumeSessionId && req.resumeAtMessageUuid
        ? { resumeSessionAt: req.resumeAtMessageUuid, forkSession: true }
        : {}),
      mcpServers: { ...(req.mcpServers ?? {}), [ASK_SERVER]: askServer },
      ...(req.pluginPaths && req.pluginPaths.length > 0
        ? { plugins: req.pluginPaths.map((path) => ({ type: "local" as const, path })) }
        : {}),
      // Explicit skill filter: only the listed skills load. Set even when empty so
      // the engine never auto-enables skills discovered under the host `~/.claude`.
      ...(req.skills ? { skills: req.skills } : {}),
      ...(req.additionalDirectories && req.additionalDirectories.length > 0
        ? { additionalDirectories: req.additionalDirectories }
        : {}),
      // The built-in question tool no-ops headlessly; ours replaces it.
      // WebSearch is NOT disallowed here on purpose: a deny rule reads to the
      // model as "web search is forbidden" and it refuses our web_search too
      // (seen live) — the system-append steers it away instead, and an
      // accidental WebSearch call just upstream-errors and self-corrects.
      disallowedTools: ["AskUserQuestion"],
      stderr: (data) => callbacks.onLog?.(data),
      canUseTool,
    };

    emit("run.status_changed", { from: "draft", to: req.mode === "plan" ? "planning" : "working" });

    let currentMessageId: string | null = null;
    const mapState: RunMapState = {
      asyncTasks: new Map(),
      result: null,
      plan: { order: [], byId: new Map(), pendingCreates: new Map() },
    };

    try {
      for await (const msg of query({ prompt: req.prompt, options })) {
        if (signal.aborted) break;
        currentMessageId = this.mapMessage(msg, emit, currentMessageId, req, mapState);
      }
      if (signal.aborted) {
        emit("run.status_changed", { from: "working", to: "cancelled", reason: "cancelled by user" });
      } else if (mapState.result && !mapState.result.ok) {
        emit("run.failed", classifyFailure(mapState.result.code ?? ""));
      } else {
        // Emitted only once the stream has fully drained: with background subagents
        // the engine sends a result frame per mini-turn, and completing on the first
        // one would freeze still-running agents into a premature "done".
        emit("run.completed", { summary: mapState.result?.summary ?? "Finished." });
      }
    } catch (err) {
      if (signal.aborted) {
        emit("run.status_changed", { from: "working", to: "cancelled", reason: "cancelled by user" });
      } else {
        emit("run.failed", classifyFailure(err instanceof Error ? err.message : String(err)));
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  /** Map one SDK message to zero or more AgentEvents. Returns the current message id. */
  private mapMessage(
    msg: SDKMessage,
    emit: (type: string, data: unknown) => void,
    currentMessageId: string | null,
    req: SdkRunRequest,
    mapState: RunMapState,
  ): string | null {
    switch (msg.type) {
      case "system": {
        // The init message carries the engine session id — the handle for resuming
        // this conversation on the next turn.
        const sys = msg as {
          subtype?: string;
          session_id?: string;
          tool_use_id?: string;
          task_id?: string;
          status?: string;
          summary?: string;
        };
        const taskToolId = (): string | undefined =>
          sys.tool_use_id ?? (sys.task_id ? mapState.asyncTasks.get(sys.task_id) : undefined);
        if (sys.subtype === "init" && sys.session_id) {
          emit("run.session_started", { sessionId: sys.session_id });
        } else if (sys.subtype === "task_notification") {
          // The REAL settle of a background subagent or workflow (its tool_result
          // was only a launch ack — see case "user").
          const toolId = taskToolId();
          if (toolId) {
            emit("tool.updated", {
              id: toolId,
              status: sys.status === "completed" ? "succeeded" : "failed",
            });
          }
        } else if (sys.subtype === "task_progress") {
          // Workflow ticks carry the full agent roster — the live fleet view.
          const agents = workflowProgressAgents(msg);
          const toolId = taskToolId();
          if (agents && toolId) {
            emit("workflow.progress", {
              toolUseId: toolId,
              ...(sys.summary ? { summary: sys.summary } : {}),
              agents,
            });
          }
        }
        return currentMessageId;
      }
      case "stream_event": {
        // Subagent streams carry parent_tool_use_id — they must never leak into the
        // main answer; their content arrives via the complete assistant messages.
        if ((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
          return currentMessageId;
        }
        const evt = msg.event as unknown as StreamEventLike;
        if (evt.type === "message_start") return randomUUID();
        if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
          const id = currentMessageId ?? randomUUID();
          emit("message.delta", { messageId: id, text: evt.delta.text ?? "" });
          return id;
        }
        return currentMessageId;
      }
      case "assistant": {
        const parentToolUseId = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id;
        const content = msg.message.content as unknown as ContentBlock[];
        // A subagent's turn: feed its texts/tool calls into that agent's transcript.
        if (parentToolUseId) {
          for (const block of content) {
            if (block.type === "text") {
              const text = (block as TextBlock).text;
              if (text.trim()) {
                emit("subagent.message", { toolUseId: parentToolUseId, text, entry: "text" });
              }
            } else if (block.type === "tool_use") {
              const tu = block as ToolUseBlock;
              emit("subagent.message", {
                toolUseId: parentToolUseId,
                text: summarizeTool(tu.name, tu.input),
                entry: "tool",
              });
            }
          }
          return currentMessageId;
        }
        // Live context gauge: this turn's usage says how full the window is.
        const usedTokens = contextTokensFromUsage((msg.message as { usage?: unknown }).usage);
        if (usedTokens != null) emit("run.context", { usedTokens });
        const id = currentMessageId ?? randomUUID();
        const texts: string[] = [];
        for (const block of content) {
          if (block.type === "tool_use") {
            const tu = block as ToolUseBlock;
            // The question tool is surfaced by its own card, not as a timeline step.
            if (tu.name === ASK_TOOL_FQN) continue;
            // Same for github_connect — the chat renders its own connect card.
            if (tu.name === GITHUB_CONNECT_TOOL_FQN) continue;
            // The todo list feeds the plan widget instead of a raw tool step.
            // Old engines: TodoWrite carries the whole list at once.
            if (tu.name === "TodoWrite") {
              const items = todosFromToolInput(tu.input);
              if (items) emit("plan.updated", { items });
              continue;
            }
            if (tu.name === "TodoRead") continue; // pure bookkeeping — not a step
            // Current engines: a Task* registry. TaskCreate's id only arrives in
            // its tool_result (handled in case "user"); updates apply right away.
            if (tu.name === "TaskCreate") {
              const subject = typeof tu.input.subject === "string" ? tu.input.subject.trim() : "";
              if (subject) mapState.plan.pendingCreates.set(tu.id, subject.slice(0, 300));
              continue;
            }
            if (tu.name === "TaskUpdate") {
              const id = typeof tu.input.taskId === "string" ? tu.input.taskId : null;
              const entry = id ? mapState.plan.byId.get(id) : undefined;
              if (id && entry) {
                if (typeof tu.input.subject === "string" && tu.input.subject.trim()) {
                  entry.text = tu.input.subject.trim().slice(0, 300);
                }
                const status = tu.input.status;
                if (status === "deleted") {
                  mapState.plan.byId.delete(id);
                  mapState.plan.order = mapState.plan.order.filter((x) => x !== id);
                } else if (
                  status === "pending" ||
                  status === "in_progress" ||
                  status === "completed"
                ) {
                  entry.status = status;
                }
                emit("plan.updated", { items: planItems(mapState.plan) });
              }
              continue;
            }
            if (tu.name === "TaskList" || tu.name === "TaskGet") continue; // reads — not steps
            const { risk } = classifyTool(tu.name);
            const call: ToolCall = {
              id: tu.id,
              runId: req.runId,
              intent: toToolIntent(tu.name, tu.input, req.workspacePath),
              summary: summarizeTool(tu.name, tu.input),
              status: "running",
              risk,
              idempotencyKey: tu.id,
            };
            emit("tool.requested", call);
          } else if (block.type === "text") {
            texts.push((block as TextBlock).text);
          }
        }
        if (texts.length > 0) {
          const sdkUuid = (msg as { uuid?: string }).uuid;
          emit("message.completed", {
            messageId: id,
            summary: texts.join(""),
            // The engine's message uuid anchors "edit this turn" (resumeSessionAt).
            ...(typeof sdkUuid === "string" && sdkUuid ? { sdkUuid } : {}),
          });
        }
        return null;
      }
      case "user": {
        // A subagent's own tool results carry parent_tool_use_id — their internal
        // tool ids never belong to the main timeline.
        if ((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
          return currentMessageId;
        }
        // Background launch ack: the Agent/Workflow tool "succeeds" instantly while
        // the work continues — task_notification is the authoritative settle. Agent
        // acks carry `agentId`, workflow acks carry `taskId`; notifications may
        // reference either, so both keys map to the launching tool_use id.
        const launch = (msg as { tool_use_result?: { status?: string; agentId?: string; taskId?: string } })
          .tool_use_result;
        const isAsyncLaunch =
          launch?.status === "async_launched" || launch?.status === "remote_launched";
        const content = msg.message.content;
        if (Array.isArray(content)) {
          for (const raw of content as unknown as ContentBlock[]) {
            if (raw.type === "tool_result") {
              const tr = raw as ToolResultBlock;
              // A parked TaskCreate settles: its result names the new task id —
              // the plan gains the item (in creation order).
              const createdSubject = mapState.plan.pendingCreates.get(tr.tool_use_id);
              if (createdSubject !== undefined) {
                mapState.plan.pendingCreates.delete(tr.tool_use_id);
                const id = tr.is_error ? null : taskIdFromCreateResult(toolResultErrorText(tr));
                if (id && !mapState.plan.byId.has(id)) {
                  mapState.plan.byId.set(id, { text: createdSubject, status: "pending" });
                  mapState.plan.order.push(id);
                  emit("plan.updated", { items: planItems(mapState.plan) });
                }
                continue;
              }
              if (isAsyncLaunch && !tr.is_error) {
                if (launch?.agentId) mapState.asyncTasks.set(launch.agentId, tr.tool_use_id);
                if (launch?.taskId) mapState.asyncTasks.set(launch.taskId, tr.tool_use_id);
                continue;
              }
              const status = tr.is_error
                ? classifyToolFailure(toolResultErrorText(tr))
                : "succeeded";
              emit("tool.updated", { id: tr.tool_use_id, status });
            }
          }
        }
        return currentMessageId;
      }
      case "result": {
        // Recorded, not emitted: streams with background subagents contain a result
        // frame per mini-turn — run() emits the terminal event once, after the loop.
        if (msg.subtype === "success") {
          mapState.result = { ok: true, summary: msg.result || "Done." };
        } else {
          mapState.result = { ok: false, code: msg.subtype };
        }
        const modelUsage = (msg as { modelUsage?: Record<string, { contextWindow?: number }> })
          .modelUsage;
        const windowTokens = Object.values(modelUsage ?? {}).reduce(
          (max, m) =>
            typeof m?.contextWindow === "number" && m.contextWindow > max ? m.contextWindow : max,
          0,
        );
        if (windowTokens > 0) emit("run.context", { windowTokens });
        return currentMessageId;
      }
      default:
        return currentMessageId;
    }
  }
}

/** Our TaskMode → the engine's permission mode ("ask"/"build" are legacy aliases). */
function sdkPermissionMode(mode: TaskMode): PermissionMode {
  switch (mode) {
    case "plan":
      return "plan";
    case "acceptEdits":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "bypass":
      return "bypassPermissions";
    default:
      return "default";
  }
}

/** Render the user's answer as the plain-text tool result the model reads back. */
function formatAnswer(request: QuestionRequest, answer: QuestionAnswer): string {
  if (answer.skipped) {
    return "The user skipped these questions. Proceed with sensible defaults and your best judgment.";
  }
  const lines = request.questions.map((q, i) => {
    const reply = answer.answers[i];
    const parts = [...(reply?.selected ?? [])];
    if (reply?.custom) parts.push(reply.custom);
    const value = parts.length > 0 ? parts.join(", ") : "(no answer)";
    return `${q.header}: ${value}`;
  });
  return `The user answered:\n${lines.join("\n")}`;
}

/** Case/separator-insensitive path form for prefix checks (Windows-friendly). */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** A directory as a normalized prefix that only matches whole path segments. */
export function normalizeDirPrefix(p: string): string {
  const n = normalizePath(p);
  return n.endsWith("/") ? n : `${n}/`;
}

/**
 * True when `target` lies inside one of the normalized root prefixes. We do not
 * resolve the filesystem, so any `.`/`..` segment (which could escape the root
 * after resolution) disqualifies the fast path — the permission card decides then.
 */
export function pathInsideRoots(target: string, roots: string[]): boolean {
  const n = normalizePath(target);
  if (n.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  return roots.some((root) => n.startsWith(root));
}

function buildScope(workspaceId: string, cwd: string, input: Record<string, unknown>): PermissionScope {
  const scope: PermissionScope = { workspaceId };
  const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
  const command = typeof input.command === "string" ? input.command : undefined;
  const url = typeof input.url === "string" ? input.url : undefined;
  if (filePath) scope.paths = [filePath];
  if (command) {
    scope.argv = [command];
    scope.cwd = cwd;
  }
  if (url) {
    try {
      scope.host = new URL(url).host;
    } catch {
      /* leave host unset */
    }
  }
  return scope;
}
