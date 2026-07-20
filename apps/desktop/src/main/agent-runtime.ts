import { randomUUID } from "node:crypto";
import { SdkAgentSession, type AgentRunCallbacks, type SdkRunRequest } from "@wello-code/agent-sdk";
import {
  parseAgentEvent,
  type AgentEvent,
  type PermissionDecision,
  type PermissionRequest,
  type QuestionAnswer,
  type QuestionRequest,
} from "@wello-code/contracts";
import { pastesDir } from "./paste-store";
import { resolveRunSkills } from "./bundled-skills";
import * as github from "./github";
import { publishToGitHub } from "./github-publish";
import { loadSettings, safeMcpName, splitArgs } from "./settings-store";
import { resolveUserSkills } from "./user-skills";
import { readSelfInjectedInstructions } from "./workspace-files";
import { addWorkspaceGrant, getWorkspacePrefs } from "./workspace-prefs";

export type AgentEventSink = (event: AgentEvent) => void;

interface PendingPermission {
  resolve: (decision: PermissionDecision) => void;
  runId: string;
}

interface PendingQuestion {
  resolve: (answer: QuestionAnswer) => void;
  runId: string;
}

interface PendingGithubConnect {
  resolve: (result: { connected: boolean; login?: string }) => void;
  runId: string;
}

/**
 * Owns active agent runs in the main process. Wires each SdkAgentSession's events to
 * the renderer (via the injected sink) and turns the `canUseTool` callback into an
 * out-of-band request the renderer answers through `respondPermission`. One key is
 * fetched per run so a rotated credential takes effect immediately.
 */
export class AgentRuntime {
  private readonly aborts = new Map<string, AbortController>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly pendingConnects = new Map<string, PendingGithubConnect>();

  constructor(
    private readonly getApiKey: () => Promise<string | null>,
    private readonly emit: AgentEventSink,
  ) {}

  async start(req: SdkRunRequest): Promise<void> {
    // Register cancellation BEFORE any await: fetching the key (OS keychain
    // decrypt) and loading settings can take a moment, and a Stop pressed in that
    // window must abort — otherwise the run would proceed to edit files and spend
    // balance while the UI already shows it stopped.
    const abort = new AbortController();
    this.aborts.set(req.runId, abort);
    try {
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        this.emit(this.fail(req, "not_connected", "Сначала подключите аккаунт Wello."));
        return;
      }
      if (abort.signal.aborted) return;
      // Attach the user's configured MCP connectors and plugin dirs to this run.
      const settings = await loadSettings();
      const mcpServers: NonNullable<SdkRunRequest["mcpServers"]> = {};
      for (const s of settings.mcpServers) {
        if (!s.enabled) continue;
        if (s.transport === "stdio" && s.command?.trim()) {
          mcpServers[safeMcpName(s.name)] = { command: s.command.trim(), args: splitArgs(s.args) };
        } else if ((s.transport === "sse" || s.transport === "http") && s.url?.trim()) {
          mcpServers[safeMcpName(s.name)] = { type: s.transport, url: s.url.trim() };
        }
      }
      const userPluginPaths = settings.plugins
        .filter((p) => p.enabled && p.path.trim())
        .map((p) => p.path);
      // Bundled skills (design taste v2 etc.) load as one shipped plugin; the
      // explicit `skills` filter = enabled bundled ∪ the user's plugin skills, so
      // nothing from the host `~/.claude` leaks in.
      const { bundleDir, skills: bundleSkills } = resolveRunSkills(
        settings.bundledSkills,
        userPluginPaths,
      );
      // The user's OWN skills (the app-owned my-skills plugin) join the same
      // explicit filter — scanned fresh per run, so drops apply immediately.
      const own = await resolveUserSkills(settings.userSkills);
      const skills = [...bundleSkills, ...own.skills];
      const pluginPaths = [
        ...(bundleDir ? [bundleDir] : []),
        ...(own.pluginDir ? [own.pluginDir] : []),
        ...userPluginPaths,
      ];
      // Workspace trust decides how much of the PROJECT the engine may believe:
      // trusted folders load their CLAUDE.md/.claude settings and honor persisted
      // grants; untrusted ones run isolated AND only in asking modes (a repo must
      // not be able to auto-run itself via a stale global auto/bypass pick).
      const prefs = await getWorkspacePrefs(req.workspacePath);
      const trusted = prefs.trusted === true;
      const mode = !trusted && (req.mode === "auto" || req.mode === "bypass") ? "manual" : req.mode;
      // AGENTS.md is honored by injecting it ourselves (the engine only loads
      // CLAUDE.md natively) — trusted folders only, like every project input.
      const projectInstructions = trusted
        ? ((await readSelfInjectedInstructions(req.workspacePath).catch(() => null)) ?? undefined)
        : undefined;
      // GitHub status shapes the system prompt (connected → "git push just
      // works"; not → "call github_connect first"), and the credential bridge
      // env makes every git the agent spawns authenticate as the user. The
      // bridge goes to TRUSTED folders only — an untrusted repo is exactly the
      // prompt-injection carrier that must not see the token; publishing still
      // works there via github_create_repo (main pushes with its own auth).
      const ghStatus = await github.authStatus().catch(() => ({ connected: false }) as const);
      const gitEnv = trusted ? ((await github.gitAuthEnv().catch(() => null)) ?? undefined) : undefined;
      // The pastes folder holds clipboard screenshots the model opens via Read —
      // whitelist it so viewing an attachment never needs a permission card.
      req = {
        ...req,
        mode,
        trusted,
        workspaceGrants: trusted ? prefs.grantedCaps : [],
        ...(projectInstructions ? { projectInstructions } : {}),
        mcpServers,
        pluginPaths,
        skills,
        additionalDirectories: [pastesDir()],
        github: {
          connected: ghStatus.connected,
          ...("login" in ghStatus && ghStatus.login ? { login: ghStatus.login } : {}),
        },
        ...(gitEnv ? { gitEnv } : {}),
      };
      if (abort.signal.aborted) return;

      const session = new SdkAgentSession({ apiKey });
      const callbacks: AgentRunCallbacks = {
        onEvent: (event) => this.emit(event),
        requestPermission: (request: PermissionRequest) =>
          new Promise<PermissionDecision>((resolve) => {
            this.pending.set(request.id, { resolve, runId: req.runId });
          }),
        requestQuestion: (request: QuestionRequest) =>
          new Promise<QuestionAnswer>((resolve) => {
            this.pendingQuestions.set(request.id, { resolve, runId: req.runId });
          }),
        // «Разрешить для проекта» — persisted per workspace, applied on the
        // NEXT runs too (this run already honors it via the in-run grant set).
        onWorkspaceGrant: (capability) => {
          void addWorkspaceGrant(req.workspacePath, capability);
        },
        // github_connect: show the chat's one-click connect card and wait. When
        // GitHub is ALREADY connected (e.g. moments ago in this same run) the
        // card is skipped and the tool resolves instantly.
        requestGithubConnect: async (request) => {
          const status = await github.authStatus().catch(() => ({ connected: false }) as const);
          if (status.connected) {
            return {
              connected: true,
              ...("login" in status && status.login ? { login: status.login } : {}),
            };
          }
          return new Promise((resolve) => {
            this.pendingConnects.set(request.id, { resolve, runId: request.runId });
            this.emit(
              parseAgentEvent({
                id: randomUUID(),
                schemaVersion: 1,
                type: "github.connect_requested",
                timestamp: new Date().toISOString(),
                correlationId: randomUUID(),
                taskId: req.taskId,
                runId: req.runId,
                data: { id: request.id, runId: request.runId },
              }),
            );
          });
        },
        // github_create_repo: create → attach origin → push, main-process side,
        // so it works even when the run started before GitHub was connected.
        createGithubRepo: (input) =>
          publishToGitHub(req.workspacePath, { ...input, push: true }),
      };
      await session.run(req, callbacks, abort.signal);
    } catch (err) {
      this.emit(this.fail(req, "runtime_error", err instanceof Error ? err.message : String(err)));
    } finally {
      this.aborts.delete(req.runId);
      this.denyRunPermissions(req.runId);
    }
  }

  cancel(runId: string): void {
    this.aborts.get(runId)?.abort();
    this.denyRunPermissions(runId);
  }

  /** Whether any agent run is still in flight (drives the close confirmation). */
  hasActive(): boolean {
    return this.aborts.size > 0;
  }

  /**
   * Abort every in-flight run (app quit): the SDK abort kills its `claude`
   * subprocess, so no engine process survives the app as an orphan.
   */
  cancelAll(): void {
    for (const runId of [...this.aborts.keys()]) this.cancel(runId);
  }

  respondPermission(requestId: string, decision: PermissionDecision): void {
    const entry = this.pending.get(requestId);
    if (entry) {
      entry.resolve(decision);
      this.pending.delete(requestId);
    }
  }

  respondQuestion(answer: QuestionAnswer): void {
    const entry = this.pendingQuestions.get(answer.requestId);
    if (entry) {
      entry.resolve(answer);
      this.pendingQuestions.delete(answer.requestId);
    }
  }

  /** The chat connect-card finished (or was dismissed) — settle github_connect.
   *  The login is re-read from the live status, never trusted from the renderer. */
  async respondGithubConnect(requestId: string, connected: boolean): Promise<void> {
    const entry = this.pendingConnects.get(requestId);
    if (!entry) return;
    this.pendingConnects.delete(requestId);
    if (!connected) {
      entry.resolve({ connected: false });
      return;
    }
    const status = await github.authStatus().catch(() => ({ connected: false }) as const);
    entry.resolve(
      status.connected
        ? { connected: true, ...("login" in status && status.login ? { login: status.login } : {}) }
        : { connected: false },
    );
  }

  private denyRunPermissions(runId: string): void {
    for (const [id, entry] of this.pending) {
      if (entry.runId === runId) {
        entry.resolve("deny");
        this.pending.delete(id);
      }
    }
    // A run that ends with a question still open (cancel / failure) must not leave the
    // model's tool call hanging — resolve it as skipped.
    for (const [id, entry] of this.pendingQuestions) {
      if (entry.runId === runId) {
        entry.resolve({ requestId: id, answers: [], skipped: true });
        this.pendingQuestions.delete(id);
      }
    }
    // Same for a connect card left open — settled as "declined".
    for (const [id, entry] of this.pendingConnects) {
      if (entry.runId === runId) {
        entry.resolve({ connected: false });
        this.pendingConnects.delete(id);
      }
    }
  }

  private fail(req: SdkRunRequest, code: string, message: string): AgentEvent {
    return parseAgentEvent({
      id: randomUUID(),
      schemaVersion: 1,
      type: "run.failed",
      timestamp: new Date().toISOString(),
      correlationId: randomUUID(),
      taskId: req.taskId,
      runId: req.runId,
      data: { code, message, retryable: false },
    });
  }
}
