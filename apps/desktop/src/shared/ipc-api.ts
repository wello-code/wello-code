import type { AgentEvent, PermissionDecision, QuestionAnswer, TaskMode } from "@wello-code/contracts";

/**
 * The typed API surface exposed to the renderer via the preload `contextBridge`.
 * Shared by preload (implements it) and renderer (types `window.wello`). Every
 * method is a named verb over a fixed IPC channel — never a generic invoke/exec.
 */
export interface AppInfo {
  name: string;
  version: string;
  platform: string;
  /** Absolute path of the main-process log, surfaced in Settings for bug reports. */
  logPath: string;
}

/** Connection status shown to the renderer. The key itself never crosses the bridge. */
export interface Connection {
  connected: boolean;
  balanceCents?: number;
  /** Account e-mail (null on gateways that predate the identity fields). */
  email?: string | null;
  /** Display name the user set in web Settings, when any. */
  displayName?: string | null;
  /** How the next agent turn is funded: plan first, then the balance (/code API). */
  billing?: "subscription" | "payg" | "blocked";
  /** Active plan id (pro/max5/max20) when billing rides the subscription. */
  planId?: string | null;
  /** Whether the account has an active paid plan (Wello Code is a Pro+ perk). */
  planActive?: boolean;
  /** Account-wide "PAYG beyond the plan limit" flag (null = unknown). */
  overflowEnabled?: boolean | null;
  /** Used fraction (0..1) of the monthly subscription cap (resets on renewal). */
  usedFraction?: number | null;
  error?: string;
}

export interface WorkspaceInfo {
  id: string;
  path: string;
  name: string;
}

/** The user's trust decision for a folder + its persisted permission grants. */
export interface WorkspaceTrust {
  /** Whether the question was ever answered for this folder. */
  decided: boolean;
  trusted: boolean;
  /** Capabilities granted with «Разрешить для проекта» (empty when untrusted). */
  grantedCaps: string[];
}

export interface GitFile {
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
}

export interface GitStatus {
  isRepo: boolean;
  files: GitFile[];
  /** True when the git CLI itself is missing (ENOENT) — distinct from "not a repo". */
  gitMissing?: boolean;
}

/** The current branch for the chat status chip. */
export interface GitBranchInfo {
  isRepo: boolean;
  /** Branch name; null on unborn HEAD (the renderer words it «main (нет коммитов)»). */
  branch: string | null;
  /** A repo whose HEAD has no commits yet (fresh `git init`). */
  unborn: boolean;
  /** True when the git CLI is not installed at all. */
  gitMissing: boolean;
}

/** Outcome of a git mutation (commit / init / sync / branch): git's own words on failure. */
export interface CommitResult {
  ok: boolean;
  shortHash?: string;
  stderr?: string;
  /** Machine-readable refusal: "dirty" = uncommitted changes block a branch switch. */
  code?: "dirty";
}

/** Local-refs-only remote picture for the branch popover (no network). */
export interface GitSyncInfo {
  /** origin URL, or null when the repo has no origin yet. */
  remote: string | null;
  /** Whether the CURRENT branch tracks an upstream. */
  upstream: boolean;
  ahead: number;
  behind: number;
  detached: boolean;
  /** Short HEAD hash when detached (the «HEAD @ abc1234» chip). */
  head: string | null;
}

export interface GitBranchList {
  ok: boolean;
  branches: string[];
  /** Current branch; null when detached or unborn. */
  current: string | null;
  stderr?: string;
}

/** The repo's merge/rebase conflict state (empty = clean). */
export interface GitConflictInfo {
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  files: string[];
}

/* ── GitHub (git stage 3): Device Flow auth + Create PR ─────────────────── */

export interface GitHubAuthStatus {
  connected: boolean;
  login?: string;
}

export interface GitHubDeviceStart {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface GitHubDeviceResult {
  ok: boolean;
  login?: string;
  /** access_denied | expired_token | network | cancelled */
  error?: "access_denied" | "expired_token" | "network" | "cancelled";
}

/** Everything the Create-PR modal needs, gathered in one main-process pass. */
export interface PrContext {
  /** owner/repo when origin points at github.com; null otherwise. */
  owner: string | null;
  repo: string | null;
  /** The repo's default branch (GitHub API), base-select preselection. */
  defaultBranch: string | null;
  /** Remote branches (origin/*, local refs) for the base select. */
  remoteBranches: string[];
  /** Current local branch (the PR head), null when detached/unborn. */
  head: string | null;
  /** Last commit subject — the title prefill. */
  lastSubject: string | null;
  /** Commits not yet pushed (push runs first when > 0). */
  ahead: number;
  error?: string;
}

export interface CreatePrInput {
  title: string;
  body: string;
  head: string;
  base: string;
  draft: boolean;
}

export interface CreatePrResult {
  ok: boolean;
  number?: number;
  url?: string;
  error?: string;
  /** The 422 "already exists" case, with the live PR when it could be found. */
  exists?: { number: number; url: string };
  /** The token turned out revoked — the UI flips to "not connected". */
  auth?: boolean;
}

export interface CreateRepoInput {
  name: string;
  private: boolean;
  description?: string;
}

export interface CreateRepoResult {
  ok: boolean;
  /** The FINAL name/URLs as GitHub answered (the API normalizes names itself). */
  name?: string;
  fullName?: string;
  url?: string;
  cloneUrl?: string;
  private?: boolean;
  error?: string;
  /** 422 "name already exists on this account" — the form offers a rename. */
  nameTaken?: boolean;
  /** The token turned out revoked — the UI flips to "not connected". */
  auth?: boolean;
}

/** The one-click "publish to GitHub" outcome (create → attach origin → push). */
export interface PublishRepoResult {
  ok: boolean;
  /** The repo page URL when the repo was created (even if the push failed). */
  url?: string;
  fullName?: string;
  /** Whether the initial push went through (false + error → retry via «Отправить»). */
  pushed?: boolean;
  error?: string;
  nameTaken?: boolean;
  auth?: boolean;
}

/** CI-checks rollup for a PR's head commit (null = no checks configured). */
export interface PullChecks {
  total: number;
  passed: number;
  failed: number;
  running: number;
  state: "success" | "failure" | "pending";
}
/** The open PR for a branch + its checks + review-comment count. */
export interface PullStatus {
  number: number;
  url: string;
  title: string;
  draft: boolean;
  reviewComments: number;
  checks: PullChecks | null;
}

/** A changed file with its added/removed line counts (for the change-set card). */
export interface ChangedFile extends GitFile {
  additions: number;
  deletions: number;
}

export interface ChangeSummary {
  isRepo: boolean;
  /** Which backend produced this: git repo, snapshot (plain folder), or none yet. */
  backing?: "git" | "snapshot" | "none";
  /** True when the git CLI is missing — the panel hides «Инициализировать git» then. */
  gitMissing?: boolean;
  files: ChangedFile[];
  additions: number;
  deletions: number;
}

export interface StartRunInput {
  taskId: string;
  runId: string;
  workspaceId: string;
  workspacePath: string;
  mode: TaskMode;
  prompt: string;
  model?: string;
  /** Reasoning effort: low → max, plus "ultra" (= xhigh + subagent orchestration). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** Resume this engine session — a follow-up turn in the same task. */
  resumeSessionId?: string;
  /** Edit-a-turn: fork the resumed session at this engine message uuid. */
  resumeAtMessageUuid?: string;
}

/**
 * Durable snapshot of the renderer's session (tasks + last workspace). Task entries
 * are renderer-owned and opaque to main — only `version` gates their format.
 */
export interface PersistedState {
  version: 1;
  workspace: WorkspaceInfo | null;
  activeId: string | null;
  tasks: unknown[];
  /** Unsent composer drafts by chat id — restored so a half-typed message
   *  survives a restart. Absent in states written by pre-2026-07-18 builds. */
  drafts?: Record<string, string>;
}

/** A user-configured MCP connector (stdio command or remote endpoint). */
export interface McpServerSetting {
  id: string;
  name: string;
  enabled: boolean;
  transport: "stdio" | "sse" | "http";
  /** stdio: executable + argument string (quotes honored). */
  command?: string;
  args?: string;
  /** sse/http: endpoint URL. */
  url?: string;
}

/** A local plugin/skill directory loaded into the engine. */
export interface PluginSetting {
  id: string;
  path: string;
  enabled: boolean;
}

export interface AppSettings {
  mcpServers: McpServerSetting[];
  plugins: PluginSetting[];
  /** System notification when a run finishes / needs input while the window is
   *  unfocused (default on). */
  notifications?: boolean;
  /**
   * Per-skill on/off for the app's bundled skills (see shared/bundled-skills.ts),
   * keyed by skill id. Missing/absent → the skill's catalog default (taste v2 on).
   */
  bundledSkills?: Record<string, boolean>;
  /**
   * Per-skill on/off for the user's OWN skills (the my-skills plugin folder),
   * keyed by folder id. Missing entry → enabled (a freshly dropped skill is on).
   */
  userSkills?: Record<string, boolean>;
  /** Prefix prefilled into the branch popover's «Новая ветка» input ("" = none). */
  gitBranchPrefix?: string;
  /** Extra instructions appended to the commit-message generation prompt ("" = none). */
  gitCommitInstructions?: string;
  /** Whether the Create-PR modal's «Черновик» starts checked (default on). */
  gitPrDraftDefault?: boolean;
  /** Extra instructions appended to the PR-description generation prompt ("" = none). */
  gitPrInstructions?: string;
}

/** Result of reading a workspace file for the inspector's file view. */
export type WorkspaceFile =
  | { ok: true; content: string }
  | { ok: false; reason: "missing" | "too_large" | "binary" };

/** File metadata for the composer's Claude-style attachment limits. */
export interface PathStat {
  path: string;
  size: number;
  isDirectory: boolean;
}

/** Where the workspace's built index.html lives (for the preview pane). */
export interface PreviewRootInfo {
  root: string;
  entry: string;
}
/** Result of starting the preview: a framed loopback URL, or a reason it can't. */
export type PreviewStart = { url: string; entry: string } | { error: string };

/** On-screen rect of the preview pane (CSS px) — where the native view sits. */
export interface PreviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Navigation state of the native preview browser (drives the address bar). */
export interface PreviewViewNavState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

/** A candidate dev-server script found in the workspace's package.json. */
export interface DevScriptInfo {
  script: string;
  framework: string | null;
  defaultPort: number;
  recommended: boolean;
}
/** Live state of a running dev server (for the preview toolbar). */
export interface DevServerState {
  id: string;
  workspacePath: string;
  status: "idle" | "starting" | "listening" | "stopped" | "crashed";
  url?: string;
  port?: number;
  exitCode?: number;
}
/** A dev-server state change, optionally carrying one line of its output. */
export interface DevServerEvent extends DevServerState {
  logLine?: string;
}

/** A chunk of terminal output for a session. */
export interface TerminalData {
  id: string;
  data: string;
}
/** A terminal session's shell exited. */
export interface TerminalExit {
  id: string;
  code: number | null;
}

export interface WelloApi {
  ping(): Promise<"pong">;
  getAppInfo(): Promise<AppInfo>;
  /** Reveal the main-process log in the OS file manager (for attaching to a report). */
  showLog(): Promise<void>;
  /** Open an https/http URL in the OS browser (for links in rendered markdown). */
  openExternal(url: string): Promise<void>;
  /** Repaint the native window-button overlay to match the app theme (win32). */
  setTitleBarOverlay(opts: { color: string; symbolColor: string }): Promise<void>;
  /**
   * Main held a window close because an agent run is in flight and asks the
   * renderer to confirm. Returns unsubscribe.
   */
  onCloseRequested(handler: () => void): () => void;
  /** The user confirmed quitting mid-run — main stops holding the close. */
  confirmClose(): Promise<void>;
  /** Minimize instead of closing — leaves a run going with the renderer alive. */
  minimizeWindow(): Promise<void>;
  /** Reveal an opened workspace root in the OS file manager (allowlist-gated). */
  revealWorkspace(dir: string): Promise<void>;

  // Connection (Wello account key; validated against the gateway balance endpoint).
  setApiKey(key: string): Promise<Connection>;
  /**
   * Browser sign-in: opens wello.dev/code-auth in the system browser and waits
   * for it to deliver a freshly minted key (already-signed-in there = one click).
   * Resolves {connected:false} with no error when the user cancels the wait.
   */
  signInViaBrowser(): Promise<Connection>;
  /** Aborts a pending browser sign-in wait (closes the loopback listener). */
  cancelBrowserSignIn(): Promise<void>;
  getConnection(): Promise<Connection>;
  /** Account-wide "PAYG beyond the plan limit" switch; resolves to fresh status. */
  setPaygOverflow(enabled: boolean): Promise<Connection>;
  clearApiKey(): Promise<void>;

  // Workspace.
  openWorkspace(): Promise<WorkspaceInfo | null>;
  /** The folder's trust decision + persisted «для проекта» grants. */
  getWorkspaceTrust(path: string): Promise<WorkspaceTrust>;
  /** Record the user's trust decision (revoking also clears every grant). */
  setWorkspaceTrust(path: string, trusted: boolean): Promise<void>;
  /** Drop the folder's persisted permission grants. */
  clearWorkspaceGrants(path: string): Promise<void>;
  /** Which project-instruction file the folder carries (CLAUDE.md / AGENTS.md). */
  workspaceInstructions(path: string): Promise<{ file: string | null }>;

  // Durable session state (tasks + last workspace survive restarts).
  loadState(): Promise<PersistedState | null>;
  saveState(state: PersistedState): Promise<void>;

  // App settings (MCP connectors, plugins).
  getSettings(): Promise<AppSettings>;
  setSettings(settings: AppSettings): Promise<void>;
  /** The user's own skills found in the my-skills plugin folder (fresh scan). */
  listUserSkills(): Promise<Array<{ id: string; name: string; description: string }>>;
  /** Create (if needed) and reveal the my-skills folder in the OS file manager. */
  openUserSkillsFolder(): Promise<void>;
  /** Project slash commands (.claude/commands) of a TRUSTED workspace (fresh scan). */
  listProjectCommands(
    workspacePath: string,
  ): Promise<Array<{ name: string; description: string; argumentHint?: string; body: string }>>;
  pickFolder(title: string): Promise<string | null>;
  pickFiles(title: string): Promise<string[]>;

  /** Persist a pasted clipboard image; returns its absolute path (null = rejected). */
  savePastedImage(data: ArrayBuffer, mime: string): Promise<string | null>;
  /**
   * Image bytes as a data: URL for chat previews (CSP allows img-src data: only).
   * Null for non-image extensions, missing files, or absurdly large ones.
   */
  readImageData(path: string): Promise<string | null>;
  /** stat() for picked/dropped paths — attachment size limits. Missing paths omitted. */
  statPaths(paths: string[]): Promise<PathStat[]>;
  /** Copy text via the main-process clipboard (no Chromium permission dance). */
  copyText(text: string): Promise<void>;
  /**
   * Absolute path of a dropped File (Electron 32+ removed File.path from the
   * renderer). Synchronous — runs in the preload, not over IPC. Empty string
   * when the file does not live on disk.
   */
  getPathForFile(file: File): string;

  // Workspace file access for the inspector's file view.
  readWorkspaceFile(workspacePath: string, file: string): Promise<WorkspaceFile>;
  /** `/`-separated relative paths of workspace files, for the @-mention picker. */
  listWorkspaceFiles(workspacePath: string): Promise<string[]>;
  openWorkspaceFile(workspacePath: string, file: string): Promise<void>;

  /** Short Haiku-generated task title (null on any failure). */
  generateTitle(prompt: string): Promise<string | null>;
  /** Save a Markdown transcript via the OS save dialog; true when written. */
  exportChat(name: string, content: string): Promise<boolean>;
  /** A handoff note compressing a chat, for «Продолжить в новом чате» (null on failure). */
  generateHandoff(transcript: string, model: string): Promise<string | null>;

  // Agent run lifecycle.
  startRun(input: StartRunInput): Promise<void>;
  cancelRun(runId: string): Promise<void>;
  /** Whether a pre-turn checkpoint exists (gates «Откатить сюда»). */
  checkpointExists(taskId: string, turnId: string): Promise<boolean>;
  /** Restore the project to a turn's pre-run checkpoint (destructive — confirm first). */
  restoreCheckpoint(taskId: string, turnId: string, workspacePath: string): Promise<boolean>;
  respondPermission(requestId: string, decision: PermissionDecision): Promise<void>;
  respondQuestion(answer: QuestionAnswer): Promise<void>;

  // Change review (git-backed).
  gitStatus(workspacePath: string): Promise<GitStatus>;
  gitDiff(workspacePath: string, file: string): Promise<{ diff: string; untracked: boolean }>;
  gitRevertFile(workspacePath: string, file: string): Promise<void>;
  gitChangeSummary(workspacePath: string): Promise<ChangeSummary>;

  // Local git, stage 1: the branch chip, init and commit-as-accept.
  gitBranchInfo(workspacePath: string): Promise<GitBranchInfo>;
  /** `git add -A` + `git commit -m message` (the message is its own argv element). */
  gitCommitAll(workspacePath: string, message: string): Promise<CommitResult>;
  /** `git init` a plain folder; drops the task's snapshot so review re-reads from git. */
  gitInit(workspacePath: string, taskId: string): Promise<CommitResult>;
  /** One-line commit message suggested by the model from the change diff. */
  gitCommitMessage(diff: string, model: string): Promise<string | null>;

  // Local git, stage 2: remote sync + branches (auth = the git credential helper).
  gitSyncInfo(workspacePath: string): Promise<GitSyncInfo>;
  gitFetch(workspacePath: string): Promise<CommitResult>;
  gitPush(workspacePath: string): Promise<CommitResult>;
  gitPull(workspacePath: string): Promise<CommitResult>;
  gitListBranches(workspacePath: string): Promise<GitBranchList>;
  gitSwitchBranch(workspacePath: string, name: string): Promise<CommitResult>;
  gitCreateBranch(workspacePath: string, name: string): Promise<CommitResult>;
  gitAddRemote(workspacePath: string, url: string): Promise<CommitResult>;
  /** Check out a remote branch (origin/<name>) into a local tracking branch. */
  gitCheckoutRemote(workspacePath: string, name: string): Promise<CommitResult>;
  /** Rename a local branch (the current one when `from` is blank). */
  gitRenameBranch(workspacePath: string, from: string, to: string): Promise<CommitResult>;
  /** Delete a local branch (never the current; `-d` unless force). */
  gitDeleteBranch(workspacePath: string, name: string, force: boolean): Promise<CommitResult>;
  /** Stash the working tree (incl. untracked). */
  gitStashPush(workspacePath: string): Promise<CommitResult>;
  /** Pop the most recent stash. */
  gitStashPop(workspacePath: string): Promise<CommitResult>;
  /** How many stash entries exist. */
  gitStashCount(workspacePath: string): Promise<number>;
  /** Remote branch names (origin/*, local refs, no network). */
  gitRemoteBranches(workspacePath: string): Promise<string[]>;
  /** Unmerged paths + which merge/rebase operation is in flight. */
  gitConflictInfo(workspacePath: string): Promise<GitConflictInfo>;
  /** Abort the in-flight merge/rebase/cherry-pick/revert. */
  gitAbortConflict(workspacePath: string): Promise<CommitResult>;

  // GitHub (git stage 3): Device Flow auth + Create PR (main-process only).
  githubStatus(): Promise<GitHubAuthStatus>;
  /** Open PR for a branch + its CI-checks rollup and review-comment count (null = none). */
  githubPullForBranch(workspacePath: string, branch: string): Promise<PullStatus | null>;
  githubDeviceStart(): Promise<GitHubDeviceStart>;
  /** Resolves when the running Device Flow finishes (token stored / error / cancel). */
  githubDeviceWait(): Promise<GitHubDeviceResult>;
  githubDeviceCancel(): Promise<void>;
  githubDisconnect(): Promise<void>;
  /** One click: create the repo on GitHub → attach origin → push. */
  githubPublishRepo(
    workspacePath: string,
    input: { name: string; private: boolean },
  ): Promise<PublishRepoResult>;
  /** The chat connect-card's answer to the agent's github_connect tool. */
  respondGithubConnect(requestId: string, connected: boolean): Promise<void>;
  /** Origin ref + default/remote branches + head/subject/ahead for the PR modal. */
  githubPrContext(workspacePath: string): Promise<PrContext>;
  /** Pushes first when ahead > 0, then opens the PR. */
  githubCreatePr(workspacePath: string, input: CreatePrInput): Promise<CreatePrResult>;
  /** Generated title + markdown body from the branch's commits/diff, in the given model. */
  githubPrText(
    workspacePath: string,
    base: string,
    model: string,
  ): Promise<{ title: string; body: string } | null>;
  /** git check-ref-format for the branch-prefix setting ("" is always fine). */
  gitValidateBranchPrefix(prefix: string): Promise<{ ok: boolean; error?: string }>;

  // Change review (dispatched: git repo → git; plain folder → per-task snapshot).
  reviewSummary(workspacePath: string, taskId: string): Promise<ChangeSummary>;
  reviewDiff(
    workspacePath: string,
    taskId: string,
    file: string,
  ): Promise<{ diff: string; untracked: boolean }>;
  reviewRevertFile(workspacePath: string, taskId: string, file: string): Promise<void>;
  reviewRevertAll(workspacePath: string, taskId: string): Promise<void>;
  reviewForget(taskId: string): Promise<void>;

  // Live preview (loopback static server shown in the native preview browser).
  startPreview(workspacePath: string): Promise<PreviewStart>;
  stopPreview(): Promise<void>;
  resolvePreviewRoot(workspacePath: string): Promise<PreviewRootInfo | null>;
  /** Fires when a watched preview file changed (reload the view). Returns unsubscribe. */
  onPreviewChange(handler: () => void): () => void;

  // Native preview browser: a real browser surface (WebContentsView) laid over
  // the pane's rectangle — loads ANY site (X-Frame-Options doesn't apply),
  // links and redirects work. The renderer owns geometry, main owns the page.
  previewViewShow(
    bounds: PreviewBounds,
    url: string | null,
    device: "mobile" | "tablet" | "desktop",
  ): Promise<void>;
  previewViewHide(): Promise<void>;
  previewViewDestroy(): Promise<void>;
  previewViewBack(): Promise<void>;
  previewViewForward(): Promise<void>;
  previewViewReload(): Promise<void>;
  /** Screenshot the live preview page → PNG path (for attaching to the agent). */
  previewViewCapture(): Promise<string | null>;
  /** Live navigation state of the preview browser. Returns unsubscribe. */
  onPreviewViewState(handler: (state: PreviewViewNavState) => void): () => void;

  // Dev server (framework `npm run dev` framed in the preview; consent-gated).
  detectDevScripts(workspacePath: string): Promise<DevScriptInfo[]>;
  startDevServer(input: {
    workspacePath: string;
    script: string;
    defaultPort: number;
  }): Promise<DevServerState>;
  stopDevServer(id: string): Promise<void>;
  getDevServer(workspacePath: string): Promise<DevServerState | null>;
  onDevServerEvent(handler: (event: DevServerEvent) => void): () => void;

  // Terminal (persistent shell session; spawn fallback for a PTY).
  /** Starts a shell in cwd; null when the folder isn't an opened workspace. */
  createTerminal(cwd: string): Promise<{ id: string; shell: string } | null>;
  writeTerminal(id: string, data: string): Promise<void>;
  killTerminal(id: string): Promise<void>;
  onTerminalData(handler: (event: TerminalData) => void): () => void;
  onTerminalExit(handler: (event: TerminalExit) => void): () => void;

  /** Subscribe to streamed agent events. Returns an unsubscribe function. */
  onAgentEvent(handler: (event: AgentEvent) => void): () => void;
}
