import { randomUUID } from "node:crypto";
import { app } from "electron";
import {
  SdkAgentSession,
  type AgentRunCallbacks,
  type PreparedEngine,
  type SdkRunRequest,
} from "@wello-code/agent-sdk";
import {
  parseAgentEvent,
  type AgentEvent,
  type PermissionDecision,
  type PermissionRequest,
  type QuestionAnswer,
  type QuestionRequest,
} from "@wello-code/contracts";
import { log } from "./logger";
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
/**
 * How long a warmed engine waits for the message it was warmed for. It costs a
 * few hundred megabytes, so a user who started typing and walked away must not
 * keep paying for it — but a normal "type, re-read, send" pause fits easily.
 */
const PREWARM_IDLE_MS = 3 * 60_000;

export class AgentRuntime {
  private readonly aborts = new Map<string, AbortController>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly pendingConnects = new Map<string, PendingGithubConnect>();
  /**
   * «Разрешить для задачи» grants, by task id. A task is a whole multi-turn
   * conversation while each turn runs its own engine — kept here so the promise
   * «до конца этой задачи» survives the turn boundary. In-memory on purpose:
   * after an app restart the agent asks again, which is the safe direction.
   */
  private readonly taskGrants = new Map<string, Set<string>>();
  /** An engine spawned ahead of time, and the session that owns it. */
  private prepared: PreparedEngine | null = null;
  private preparedBy: SdkAgentSession | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private warming = false;

  constructor(
    private readonly getApiKey: () => Promise<string | null>,
    private readonly emit: AgentEventSink,
  ) {}

  /**
   * Everything a run needs beyond what the window sends: the key, the user's
   * settings, skills, connectors, workspace trust and the GitHub bridge.
   *
   * Split out of `start` so the pre-warm path can assemble the very same request
   * ahead of time — the engine is spawned from these values, so they are also
   * what decides whether a warmed engine fits the turn that arrives.
   */
  private async assemble(
    req: SdkRunRequest,
    aborted?: () => boolean,
  ): Promise<{ req: SdkRunRequest; apiKey: string } | null> {
    {
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        this.emit(this.fail(req, "not_connected", "Сначала подключите аккаунт Wello."));
        return null;
      }
      if (aborted?.()) return null;
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
      // Local only: this must never put a request to github.com between Send and
      // the model's first token (see authStatusLocal).
      const ghStatus = await github.authStatusLocal().catch(() => ({ connected: false }) as const);
      const gitEnv = trusted ? ((await github.gitAuthEnv().catch(() => null)) ?? undefined) : undefined;
      // The pastes folder holds clipboard screenshots the model opens via Read —
      // whitelist it so viewing an attachment never needs a permission card.
      req = {
        ...req,
        mode,
        trusted,
        workspaceGrants: trusted ? prefs.grantedCaps : [],
        taskGrants: [...(this.taskGrants.get(req.taskId) ?? [])],
        ...(projectInstructions ? { projectInstructions } : {}),
        mcpServers,
        pluginPaths,
        skills,
        additionalDirectories: [pastesDir()],
        // How much conversation the engine carries before summarising it. The
        // user's choice (Settings → Общее); 0 = never, i.e. the model's full
        // window. Read per run, so a change applies to the very next turn.
        ...(typeof settings.autoCompactWindow === "number"
          ? { autoCompactWindow: settings.autoCompactWindow }
          : {}),
        github: {
          connected: ghStatus.connected,
          ...("login" in ghStatus && ghStatus.login ? { login: ghStatus.login } : {}),
        },
        ...(gitEnv ? { gitEnv } : {}),
      };
      if (aborted?.()) return null;
      return { req, apiKey };
    }
  }

  /** The callbacks a turn answers with: permission cards, questions, GitHub. */
  private callbacksFor(req: SdkRunRequest): AgentRunCallbacks {
    {
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
        // «Разрешить для задачи» — kept for the task's later turns (see taskGrants).
        onTaskGrant: (capability) => {
          const set = this.taskGrants.get(req.taskId) ?? new Set<string>();
          set.add(capability);
          this.taskGrants.set(req.taskId, set);
        },
        // The engine's stderr into the main log: this is where API errors and
        // engine diagnostics actually surface, and without it the log file had
        // nothing to offer when a user reported «модель выдала ошибку».
        onLog: (line) => {
          const text = line.trim();
          if (text) log.info(`engine: ${text.slice(0, 500)}`);
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
      return callbacks;
    }
  }

  /**
   * Spawn the engine while the user is still typing, so pressing Send does not
   * wait for a process to start.
   *
   * Measured on the built app against the live gateway (2026-08-02): 2.3–3.7 s
   * of every turn passed before the first byte went upstream, on every turn —
   * that is the engine starting. Warming is the same work, moved to the moment
   * the user is composing, and dropped again if they walk away.
   *
   * Best-effort throughout: any failure here just means the turn starts the
   * engine itself, exactly as before.
   */
  async prewarm(input: SdkRunRequest): Promise<void> {
    // Deliberately allowed WHILE a run is in flight: typing during an answer is
    // the type-ahead case, and refusing there costs the next turn its head start
    // (measured — the run settles seconds after its last word reaches the
    // window, and by then the user has already pressed Send). At most one spare
    // exists at a time and it is closed on idle, so the cost is bounded.
    if (this.warming) return;
    const key = await this.getApiKey().catch(() => null);
    if (!key) return;
    const session = new SdkAgentSession({ apiKey: key, appVersion: app.getVersion() });
    this.warming = true;
    try {
      const assembled = await this.assemble(input);
      if (!assembled) return;
      const fingerprint = session.fingerprintFor(assembled.req);
      if (this.prepared?.fingerprint === fingerprint) return; // already have it
      this.dropPrepared();
      const prepared = await session.prepare(assembled.req, this.callbacksFor(assembled.req));
      this.prepared = prepared;
      this.preparedBy = session;
      this.armIdleTimer();
    } catch (err) {
      log.warn(`prewarm failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.warming = false;
    }
  }

  /** Close a warmed engine that nobody claimed — it holds real memory. */
  private dropPrepared(): void {
    const prepared = this.prepared;
    this.prepared = null;
    this.preparedBy = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    try {
      prepared?.warm?.close();
    } catch {
      /* already gone */
    }
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dropPrepared(), PREWARM_IDLE_MS);
    this.idleTimer.unref?.();
  }

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
      const assembled = await this.assemble(req, () => abort.signal.aborted);
      if (!assembled) return;
      const session =
        this.preparedBy ??
        new SdkAgentSession({ apiKey, appVersion: app.getVersion() });
      // A warmed engine is only usable when it was built for exactly this shape
      // of turn (model, folder, mode, skills, connectors, key). Anything else
      // starts its own, as before.
      const prepared =
        this.prepared && this.prepared.fingerprint === session.fingerprintFor(assembled.req)
          ? this.prepared
          : undefined;
      if (prepared) {
        this.prepared = null; // claimed: a warm handle serves exactly one turn
        this.preparedBy = null;
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
          this.idleTimer = null;
        }
      } else {
        this.dropPrepared(); // stale spare, and this turn will not use it
      }
      // One line per turn: "was the engine ready?" is the first question when
      // someone reports that sending felt slow.
      log.info(prepared ? "turn on a warmed engine" : "turn starts its own engine");
      if (abort.signal.aborted) return;
      await session.run(
        assembled.req,
        this.callbacksFor(assembled.req),
        abort.signal,
        prepared,
      );
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
    this.dropPrepared();
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
