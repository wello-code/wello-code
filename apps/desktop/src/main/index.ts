import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, session, shell } from "electron";
import { join } from "node:path";
import type { AgentEvent, PermissionDecision, QuestionAnswer } from "@wello-code/contracts";
import type {
  AppInfo,
  AppSettings,
  Connection,
  PersistedState,
  StartRunInput,
  WorkspaceInfo,
} from "../shared/ipc-api";
import { clearApiKey, getApiKey, setApiKey } from "./credentials";
import { installCrashHandlers, log, logPath } from "./logger";
import {
  checkForUpdates,
  downloadUpdate,
  initUpdater,
  installUpdate,
  updateStatus,
} from "./updater";
import {
  fetchAccess,
  generateCommitMessage,
  generateHandoff,
  generatePrText,
  generateTitle,
  revokeCurrentKey,
  setPaygOverflow,
} from "./wello-client";
import * as github from "./github";
import { publishToGitHub } from "./github-publish";
import { parseGitHubRemote } from "../shared/github";
import {
  AuthCancelledError,
  AuthExpiredError,
  AuthTimeoutError,
  startBrowserSignIn,
  type BrowserSignIn,
} from "./auth-device";
import { AgentRuntime } from "./agent-runtime";
import * as gitService from "./git";
import { loadState, saveState } from "./state-store";
import { loadSettings, saveSettings } from "./settings-store";
import { cleanupPastes, savePastedImage, saveImageBuffer } from "./paste-store";
import { readImageData, statPaths } from "./media";
import { instructionsInfo, listWorkspaceFiles, openWorkspaceFile, readWorkspaceFile } from "./workspace-files";
import { ensureUserSkillsPlugin, listUserSkills } from "./user-skills";
import { scanProjectCommands } from "./project-commands";
import { isKnownWorkspace, registerWorkspace } from "./workspace-registry";
import {
  clearWorkspaceGrants,
  getWorkspacePrefs,
  grandfatherLegacyWorkspaces,
  setWorkspaceTrust,
} from "./workspace-prefs";
import * as reviewService from "./review";
import * as snapshot from "./snapshot";
import * as previewServer from "./preview-server";
import { resolvePreviewRoot } from "./preview-root";
import {
  previewViewBack,
  previewViewCapture,
  previewViewDestroy,
  previewViewForward,
  previewViewHide,
  previewViewReload,
  previewViewShow,
  type PreviewDevice,
  type PreviewViewBounds,
} from "./preview-view";
import { watchPreview } from "./preview-watch";
import { DevServerManager } from "./dev-server";
import { detectDevScripts } from "./dev-scripts";
import { TerminalManager } from "./terminal";
import { loadWindowBounds, trackWindowBounds } from "./window-state";

/** electron-vite sets this in dev; its absence means we're running the packaged build. */
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const isDev = Boolean(rendererUrl);

// Before anything else can throw: from here on a crash leaves a trace on disk
// instead of vanishing with the window.
installCrashHandlers();
log.info("app starting", {
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
  electron: process.versions.electron,
  dev: isDev,
});

// One instance only: a second launch would race the same wello-state.json (silent
// history corruption) and park a second fleet of engine processes. The second
// process exits; the first one gets `second-instance` and comes forward.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}
app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

let mainWindow: BrowserWindow | null = null;

// Window-close guard: while an agent run is in flight, the first close is held
// and the renderer shows a confirm ("generation in progress — quit?"). The
// renderer's app.confirmClose sets the flag and re-triggers close.
let closeConfirmed = false;

// Preview: at most one loopback server + fs.watch at a time; disposed on stop /
// workspace switch / window close so no listening socket or watch handle leaks.
let previewDispose: (() => void) | null = null;
async function stopPreview(): Promise<void> {
  previewDispose?.();
  previewDispose = null;
  await previewServer.stop();
}

// System-notification preference (default on), mirrored from settings so the
// event handler reads it synchronously.
let notificationsEnabled = true;

/**
 * A desktop notification for a run that finished or needs input — but ONLY when
 * the window isn't focused (no point nagging a user who's watching). Clicking it
 * brings the app forward; the taskbar icon also flashes until the window regains
 * focus. Silent no-op when notifications are off or unsupported.
 */
function notifyUser(body: string): void {
  if (!notificationsEnabled) return;
  if (!mainWindow || mainWindow.isFocused()) return;
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: "Wello Code", body, silent: false });
  n.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  n.show();
  mainWindow.flashFrame(true);
}

/** Maps a terminal / input-awaiting agent event to a notification. */
function notifyForEvent(event: AgentEvent): void {
  switch (event.type) {
    case "run.completed":
      notifyUser("Задача готова");
      break;
    case "run.failed":
      notifyUser("Задача завершилась с ошибкой");
      break;
    case "permission.requested":
      notifyUser("Агенту нужно разрешение, чтобы продолжить");
      break;
    case "question.requested":
      notifyUser("Агент задал уточняющий вопрос");
      break;
  }
}

/** All agent events fan out to the renderer over the single push channel. */
const runtime = new AgentRuntime(getApiKey, (event) => {
  mainWindow?.webContents.send("agent.events", event);
  notifyForEvent(event);
});

// Dev servers for the preview pane (framework `npm run dev`), keyed by workspace.
const devServers = new DevServerManager((event) => {
  mainWindow?.webContents.send("devserver.events", event);
});

// Terminal shell sessions (spawn-based fallback for a PTY).
const terminals = new TerminalManager(
  (id, data) => mainWindow?.webContents.send("terminal.data", { id, data }),
  (id, code) => mainWindow?.webContents.send("terminal.exit", { id, code }),
);

function contentSecurityPolicy(): string {
  const directives = [
    "default-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    `connect-src 'self'${isDev ? " ws:" : ""}`,
    `script-src 'self'${isDev ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // The preview pane frames a loopback static/dev server (nothing remote).
    "frame-src http://127.0.0.1:* http://localhost:*",
  ];
  return directives.join("; ");
}

/** Gate a git/file op on a folder the user actually opened (defense-in-depth). */
function allowWorkspace(workspacePath: string): boolean {
  if (isKnownWorkspace(workspacePath)) return true;
  console.warn("[wello] blocked op for unregistered workspace:", workspacePath);
  return false;
}

function registerIpc(): void {
  ipcMain.handle("app.ping", () => "pong" as const);
  ipcMain.handle(
    "app.getInfo",
    (): AppInfo => ({
      name: app.getName(),
      version: app.getVersion(),
      platform: process.platform,
      logPath: logPath(),
    }),
  );
  // Reveal the log in the file manager so a bug report is one click, not a path
  // the user has to retype. No argument: the path is ours, never the renderer's.
  ipcMain.handle("app.showLog", () => {
    shell.showItemInFolder(logPath());
  });

  ipcMain.handle("update.status", () => updateStatus());
  ipcMain.handle("update.check", () => checkForUpdates());
  ipcMain.handle("update.download", () => downloadUpdate());
  ipcMain.handle("update.install", () => installUpdate());
  ipcMain.handle("app.openExternal", (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  // The renderer confirmed quitting mid-run: stop holding close and quit for
  // real (quit, not window.close — Cmd+Q on macOS must finish as a quit).
  ipcMain.handle("app.confirmClose", (): void => {
    closeConfirmed = true;
    app.quit();
  });
  // "Minimize instead" — the safe way to leave a run going: the window hides but
  // the renderer stays alive, so the run finishes normally, autosaves, and fires
  // the completion notification. The user restores the window to a ready answer.
  ipcMain.handle("app.minimize", (): void => {
    mainWindow?.minimize();
  });
  // Re-paint the native window-button overlay when the renderer switches theme
  // (Windows-only API; colors are validated — they feed straight into the OS).
  ipcMain.handle("chrome.setOverlay", (_e, opts: { color: string; symbolColor: string }) => {
    const okColor = (v: unknown): v is string =>
      typeof v === "string" && (/^#[0-9a-f]{3,8}$/i.test(v) || /^rgba?\([\d\s.,%]+\)$/i.test(v.trim()));
    if (process.platform !== "win32" || !mainWindow || mainWindow.isDestroyed()) return;
    if (!okColor(opts?.color) || !okColor(opts?.symbolColor)) return;
    try {
      mainWindow.setTitleBarOverlay({ color: opts.color, symbolColor: opts.symbolColor, height: 40 });
    } catch {
      /* pre-overlay window (non-win32 build) — nothing to repaint */
    }
  });
  // Reveal a chat's project folder in the OS file manager. Directories only, and
  // only workspace roots the user opened themselves (A5 allowlist) — this can't
  // become an "open arbitrary path" primitive for renderer-side content.
  ipcMain.handle("workspace.reveal", async (_e, dir: string) => {
    if (typeof dir !== "string" || !allowWorkspace(dir)) return;
    try {
      if (!(await stat(dir)).isDirectory()) return;
    } catch {
      return;
    }
    void shell.openPath(dir);
  });

  // --- Connection ---------------------------------------------------------
  const toConnection = (a: Awaited<ReturnType<typeof fetchAccess>>): Connection => ({
    connected: true,
    balanceCents: a.paygBalanceCents,
    email: a.email,
    displayName: a.displayName,
    billing: a.billing,
    planId: a.planId,
    planActive: a.planActive,
    overflowEnabled: a.overflowEnabled,
    usedFraction: a.usedFraction,
  });

  ipcMain.handle("wello.setApiKey", async (_e, key: string): Promise<Connection> => {
    try {
      const access = await fetchAccess(key);
      await setApiKey(key);
      return toConnection(access);
    } catch (err) {
      return { connected: false, error: err instanceof Error ? err.message : "Не удалось подключиться." };
    }
  });

  // Browser sign-in: a device-authorization flow against the gateway plus the
  // wello.dev/code-auth page. The user confirms in the browser (already signed in
  // there = one click) and we collect the `wlo_live_…` key by polling over HTTPS.
  // The app never sees the account password — it holds only its own key (keychain).
  let pendingAuth: BrowserSignIn | null = null;
  ipcMain.handle("wello.signInViaBrowser", async (): Promise<Connection> => {
    pendingAuth?.cancel(); // a re-click restarts the wait with a fresh session
    let session: BrowserSignIn;
    try {
      session = await startBrowserSignIn();
    } catch {
      return { connected: false, error: "Не удалось начать вход. Проверьте связь и попробуйте ещё раз." };
    }
    pendingAuth = session;
    void shell.openExternal(session.verifyUrl);
    try {
      const key = await session.key;
      const access = await fetchAccess(key);
      await setApiKey(key);
      return toConnection(access);
    } catch (err) {
      if (err instanceof AuthCancelledError) return { connected: false }; // silent: user cancelled
      if (err instanceof AuthTimeoutError) {
        return {
          connected: false,
          error: "Время ожидания вышло. Нажмите «Войти через браузер» и подтвердите вход заново.",
        };
      }
      if (err instanceof AuthExpiredError) {
        return {
          connected: false,
          error: "Запрос на вход истёк. Нажмите «Войти через браузер» и подтвердите вход заново.",
        };
      }
      return { connected: false, error: err instanceof Error ? err.message : "Не удалось войти." };
    } finally {
      if (pendingAuth === session) pendingAuth = null;
    }
  });

  ipcMain.handle("wello.cancelBrowserSignIn", (): void => {
    pendingAuth?.cancel();
    pendingAuth = null;
  });
  app.on("before-quit", () => pendingAuth?.cancel());

  ipcMain.handle("wello.setPaygOverflow", async (_e, enabled: boolean): Promise<Connection> => {
    const key = await getApiKey();
    if (!key) return { connected: false, error: "Нет подключения." };
    try {
      await setPaygOverflow(key, enabled === true);
      return toConnection(await fetchAccess(key));
    } catch (err) {
      // The flag write failed — report the still-current status with the note.
      const note = err instanceof Error ? err.message : "Не удалось изменить настройку.";
      try {
        return { ...toConnection(await fetchAccess(key)), error: note };
      } catch {
        return { connected: true, error: note };
      }
    }
  });

  ipcMain.handle("wello.getConnection", async (): Promise<Connection> => {
    const key = await getApiKey();
    if (!key) return { connected: false };
    try {
      return toConnection(await fetchAccess(key));
    } catch (err) {
      // Key is stored but unreachable right now — stay connected, surface the note.
      return { connected: true, error: err instanceof Error ? err.message : "Баланс недоступен." };
    }
  });

  ipcMain.handle("wello.clearApiKey", async (): Promise<void> => {
    // Best-effort server-side revoke first: a signed-out machine should hold no
    // live credential. Offline sign-out still clears the keychain.
    const key = await getApiKey();
    if (key) await revokeCurrentKey(key);
    await clearApiKey();
  });

  // --- Workspace ----------------------------------------------------------
  ipcMain.handle("workspace.open", async (): Promise<WorkspaceInfo | null> => {
    const options = { properties: ["openDirectory" as const], title: "Выберите папку проекта" };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    const path = result.filePaths[0];
    if (result.canceled || !path) return null;
    registerWorkspace(path);
    return { id: randomUUID(), path, name: basename(path) };
  });

  // --- Durable session state ------------------------------------------------
  ipcMain.handle("state.load", async () => {
    const state = await loadState();
    // Seed the workspace allowlist from restored tasks so their diff/revert keeps
    // working after a restart (their paths never came through workspace.open).
    if (state) {
      registerWorkspace(state.workspace?.path);
      const taskIds: string[] = [];
      const legacyPaths: string[] = [];
      if (state.workspace?.path) legacyPaths.push(state.workspace.path);
      for (const t of state.tasks) {
        const wp = (t as { workspacePath?: unknown }).workspacePath;
        if (typeof wp === "string") {
          registerWorkspace(wp);
          legacyPaths.push(wp);
        }
        const id = (t as { id?: unknown }).id;
        if (typeof id === "string") taskIds.push(id);
      }
      // ONE-TIME: folders from a pre-trust build keep working without the
      // question (sealed by migratedAt — a deferred modal never auto-trusts).
      void grandfatherLegacyWorkspaces(legacyPaths);
      // Sweep snapshot dirs whose task no longer exists (orphan cleanup).
      void snapshot.gc(taskIds);
    }
    return state;
  });

  // --- Workspace trust + persisted grants + project instructions -------------
  ipcMain.handle("workspace.getTrust", (_e, path: string) =>
    typeof path === "string" && allowWorkspace(path)
      ? getWorkspacePrefs(path)
      : { decided: false, trusted: false, grantedCaps: [] },
  );
  ipcMain.handle("workspace.setTrust", (_e, path: string, trusted: boolean) => {
    if (typeof path === "string" && allowWorkspace(path)) {
      return setWorkspaceTrust(path, trusted === true);
    }
  });
  ipcMain.handle("workspace.clearGrants", (_e, path: string) => {
    if (typeof path === "string" && allowWorkspace(path)) return clearWorkspaceGrants(path);
  });
  ipcMain.handle("workspace.instructions", (_e, path: string) =>
    typeof path === "string" && allowWorkspace(path)
      ? instructionsInfo(path)
      : { file: null },
  );
  ipcMain.handle("state.save", (_e, state: PersistedState): void => {
    saveState(state);
  });

  // --- App settings (MCP connectors, plugins) --------------------------------
  ipcMain.handle("settings.get", () => loadSettings());
  ipcMain.handle("settings.set", (_e, settings: AppSettings): void => {
    notificationsEnabled = settings.notifications !== false;
    saveSettings(settings);
  });

  // --- Project slash commands (.claude/commands, trusted folders only) --------
  ipcMain.handle("commands.list", async (_e, workspacePath: string) => {
    if (typeof workspacePath !== "string" || !allowWorkspace(workspacePath)) return [];
    // Only a trusted workspace's commands run — the same gate as CLAUDE.md/skills.
    const prefs = await getWorkspacePrefs(workspacePath).catch(() => null);
    if (!prefs?.trusted) return [];
    return scanProjectCommands(workspacePath);
  });

  // --- User skills (the app-owned my-skills plugin folder) -------------------
  ipcMain.handle("userSkills.list", () => listUserSkills());
  ipcMain.handle("userSkills.openFolder", async () => {
    const root = await ensureUserSkillsPlugin();
    void shell.openPath(join(root, "skills"));
  });
  ipcMain.handle("dialog.pickFolder", async (_e, title: string): Promise<string | null> => {
    const options = { properties: ["openDirectory" as const], title };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("dialog.pickFiles", async (_e, title: string): Promise<string[]> => {
    const options = { properties: ["openFile" as const, "multiSelections" as const], title };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? [] : result.filePaths;
  });

  // --- Pasted images (composer Ctrl+V) ---------------------------------------
  ipcMain.handle("paste.saveImage", (_e, data: ArrayBuffer, mime: string) =>
    savePastedImage(data, mime),
  );

  // --- Attachment media (chat previews + Claude-style limit checks) ----------
  ipcMain.handle("media.readImage", (_e, path: string) => readImageData(path));
  ipcMain.handle("media.statPaths", (_e, paths: string[]) => statPaths(paths));

  // --- Clipboard (renderer clipboard API is permission-gated; main is not) ----
  ipcMain.handle("clipboard.copyText", (_e, text: string): void => {
    clipboard.writeText(typeof text === "string" ? text : "");
  });

  // --- Workspace file access (inspector file view) ---------------------------
  ipcMain.handle("file.read", (_e, workspacePath: string, file: string) => {
    if (!allowWorkspace(workspacePath)) return { ok: false as const, reason: "missing" as const };
    return readWorkspaceFile(workspacePath, file);
  });
  ipcMain.handle("file.openInSystem", (_e, workspacePath: string, file: string) => {
    if (!allowWorkspace(workspacePath)) return;
    return openWorkspaceFile(workspacePath, file);
  });
  ipcMain.handle("file.list", (_e, workspacePath: string): Promise<string[]> => {
    if (!allowWorkspace(workspacePath)) return Promise.resolve([]);
    return listWorkspaceFiles(workspacePath);
  });

  // --- Task title (Haiku, best-effort) ---------------------------------------
  ipcMain.handle("title.generate", async (_e, prompt: string): Promise<string | null> => {
    const key = await getApiKey();
    if (!key) return null;
    return generateTitle(key, prompt);
  });

  // --- Export chat to a Markdown file (path chosen by the OS save dialog) ------
  ipcMain.handle("chat.export", async (_e, name: string, content: string): Promise<boolean> => {
    if (typeof content !== "string" || !content) return false;
    const safeName = (typeof name === "string" ? name : "chat").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
    const options = {
      title: "Экспорт диалога",
      defaultPath: `${safeName || "chat"}.md`,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return false;
    try {
      await writeFile(result.filePath, content, "utf8");
      return true;
    } catch {
      return false;
    }
  });

  // --- Handoff note for "continue in a new chat" (current model, best-effort) --
  ipcMain.handle(
    "chat.handoff",
    async (_e, transcript: string, model: string): Promise<string | null> => {
      const key = await getApiKey();
      if (!key || typeof transcript !== "string" || !transcript.trim()) return null;
      return generateHandoff(key, transcript, typeof model === "string" && model ? model : "claude-sonnet-5");
    },
  );

  // --- Agent --------------------------------------------------------------
  ipcMain.handle("agent.start", async (_e, input: StartRunInput): Promise<void> => {
    if (allowWorkspace(input.workspacePath)) {
      // For a plain (non-git) folder, capture the pre-run baseline for snapshot
      // review BEFORE the agent's first write — awaited so nothing leaks in.
      const isRepo = (await gitService.status(input.workspacePath)).isRepo;
      if (!isRepo) {
        await snapshot.ensureBaseline(input.taskId, input.workspacePath).catch(() => undefined);
      }
      // A per-turn checkpoint (git OR not) so "rewind to this turn" can restore
      // the project to its pre-turn state. Labelled by the run id; awaited so the
      // snapshot precedes any edit. Best-effort — never blocks the run.
      await snapshot
        .captureCheckpoint(input.taskId, input.runId, input.workspacePath)
        .catch(() => undefined);
    }
    // Fire-and-forget: events stream over the push channel; never block the caller
    // for the whole (multi-second) run.
    void runtime.start(input);
  });
  ipcMain.handle("checkpoint.has", (_e, taskId: string, turnId: string) =>
    snapshot.hasCheckpoint(taskId, turnId),
  );
  ipcMain.handle(
    "checkpoint.restore",
    (_e, taskId: string, turnId: string, workspacePath: string): Promise<boolean> => {
      if (!allowWorkspace(workspacePath)) return Promise.resolve(false);
      return snapshot.restoreCheckpoint(taskId, turnId, workspacePath);
    },
  );
  ipcMain.handle("agent.cancel", (_e, runId: string): void => {
    runtime.cancel(runId);
  });
  ipcMain.handle(
    "permissions.respond",
    (_e, payload: { requestId: string; decision: PermissionDecision }): void => {
      runtime.respondPermission(payload.requestId, payload.decision);
    },
  );
  ipcMain.handle("questions.respond", (_e, answer: QuestionAnswer): void => {
    runtime.respondQuestion(answer);
  });
  ipcMain.handle("github.respondConnect", (_e, requestId: string, connected: boolean) =>
    typeof requestId === "string"
      ? runtime.respondGithubConnect(requestId, connected === true)
      : undefined,
  );

  // --- Change review (git) — all gated on a folder the user actually opened ---
  ipcMain.handle("git.status", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath) ? gitService.status(workspacePath) : { isRepo: false, files: [] },
  );
  ipcMain.handle("git.diff", (_e, workspacePath: string, file: string) =>
    allowWorkspace(workspacePath)
      ? gitService.diff(workspacePath, file)
      : { diff: "", untracked: false },
  );
  ipcMain.handle("git.revertFile", (_e, workspacePath: string, file: string) => {
    if (allowWorkspace(workspacePath)) return gitService.revertFile(workspacePath, file);
  });
  ipcMain.handle("git.changeSummary", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath)
      ? gitService.changeSummary(workspacePath)
      : { isRepo: false, files: [], additions: 0, deletions: 0 },
  );

  // --- Local git, stage 1: branch chip, commit-as-accept, init ---------------
  ipcMain.handle("git.branchInfo", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath)
      ? gitService.branchInfo(workspacePath)
      : { isRepo: false, branch: null, unborn: false, gitMissing: false },
  );
  ipcMain.handle("git.commitAll", (_e, workspacePath: string, message: string) =>
    allowWorkspace(workspacePath) && typeof message === "string"
      ? gitService.commitAll(workspacePath, message)
      : { ok: false, stderr: "Папка не открыта в приложении." },
  );
  ipcMain.handle("git.init", async (_e, workspacePath: string, taskId: string) => {
    if (!allowWorkspace(workspacePath)) return { ok: false, stderr: "Папка не открыта в приложении." };
    const result = await gitService.init(workspacePath);
    // The folder is a repo now — drop this task's snapshot so the review
    // dispatcher re-reads from the git backend (isRepo wins from here on).
    if (result.ok) await snapshot.forget(taskId).catch(() => undefined);
    return result;
  });
  ipcMain.handle("git.commitMessage", async (_e, diff: string, model: string): Promise<string | null> => {
    const key = await getApiKey();
    if (!key || typeof diff !== "string" || !diff.trim()) return null;
    // Settings are read AT USE (loadSettings hits disk) — no restart needed.
    const prefs = await loadSettings();
    return generateCommitMessage(
      key,
      diff,
      typeof model === "string" && model ? model : "claude-sonnet-5",
      prefs.gitCommitInstructions,
    );
  });
  ipcMain.handle("git.validatePrefix", (_e, prefix: string) =>
    typeof prefix === "string"
      ? gitService.validateBranchPrefix(app.getPath("userData"), prefix)
      : { ok: false, error: "Некорректное значение." },
  );

  // --- Local git, stage 2: remote sync + branches ------------------------------
  const notAllowed = { ok: false, stderr: "Папка не открыта в приложении." };
  ipcMain.handle("git.syncInfo", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath)
      ? gitService.syncInfo(workspacePath)
      : { remote: null, upstream: false, ahead: 0, behind: 0, detached: false, head: null },
  );
  // Network git ops carry the app's GitHub credential bridge: with GitHub
  // connected, github.com pushes/pulls authenticate with the stored token —
  // no GCM browser window, nothing for a novice to get lost in.
  const gitNetEnv = (): Promise<Record<string, string> | undefined> =>
    github.gitAuthEnv().then((env) => env ?? undefined);
  ipcMain.handle("git.fetch", async (_e, workspacePath: string) =>
    allowWorkspace(workspacePath) ? gitService.fetch(workspacePath, await gitNetEnv()) : notAllowed,
  );
  ipcMain.handle("git.push", async (_e, workspacePath: string) =>
    allowWorkspace(workspacePath) ? gitService.push(workspacePath, await gitNetEnv()) : notAllowed,
  );
  ipcMain.handle("git.pull", async (_e, workspacePath: string) =>
    allowWorkspace(workspacePath) ? gitService.pull(workspacePath, await gitNetEnv()) : notAllowed,
  );
  ipcMain.handle("git.listBranches", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath)
      ? gitService.listBranches(workspacePath)
      : { ok: false, branches: [], current: null },
  );
  ipcMain.handle("git.switchBranch", (_e, workspacePath: string, name: string) =>
    allowWorkspace(workspacePath) && typeof name === "string"
      ? gitService.switchBranch(workspacePath, name)
      : notAllowed,
  );
  ipcMain.handle("git.createBranch", (_e, workspacePath: string, name: string) =>
    allowWorkspace(workspacePath) && typeof name === "string"
      ? gitService.createBranch(workspacePath, name)
      : notAllowed,
  );
  ipcMain.handle("git.addRemote", (_e, workspacePath: string, url: string) =>
    allowWorkspace(workspacePath) && typeof url === "string"
      ? gitService.addRemote(workspacePath, url)
      : notAllowed,
  );
  ipcMain.handle("git.checkoutRemote", (_e, workspacePath: string, name: string) =>
    allowWorkspace(workspacePath) && typeof name === "string"
      ? gitService.checkoutRemote(workspacePath, name)
      : notAllowed,
  );
  ipcMain.handle("git.renameBranch", (_e, workspacePath: string, from: string, to: string) =>
    allowWorkspace(workspacePath) && typeof from === "string" && typeof to === "string"
      ? gitService.renameBranch(workspacePath, from, to)
      : notAllowed,
  );
  ipcMain.handle("git.deleteBranch", (_e, workspacePath: string, name: string, force: boolean) =>
    allowWorkspace(workspacePath) && typeof name === "string"
      ? gitService.deleteBranch(workspacePath, name, force === true)
      : notAllowed,
  );
  ipcMain.handle("git.stashPush", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath) ? gitService.stashPush(workspacePath) : notAllowed,
  );
  ipcMain.handle("git.stashPop", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath) ? gitService.stashPop(workspacePath) : notAllowed,
  );
  ipcMain.handle("git.stashCount", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath) ? gitService.stashCount(workspacePath) : 0,
  );
  ipcMain.handle("git.remoteBranches", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath) ? gitService.remoteBranches(workspacePath) : [],
  );
  ipcMain.handle("git.conflictInfo", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath)
      ? gitService.conflictInfo(workspacePath)
      : { operation: null, files: [] },
  );
  ipcMain.handle("git.abortConflict", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath) ? gitService.abortConflict(workspacePath) : notAllowed,
  );

  // --- GitHub (stage 3): Device Flow + Create PR ------------------------------
  ipcMain.handle("github.status", () => github.authStatus());
  ipcMain.handle("github.pullForBranch", async (_e, workspacePath: string, branch: string) => {
    if (!allowWorkspace(workspacePath) || typeof branch !== "string" || !branch) return null;
    const sync = await gitService.syncInfo(workspacePath);
    if (!sync.remote) return null;
    try {
      return await github.pullForBranch(sync.remote, branch);
    } catch {
      return null; // best-effort — auth/network issues just hide the PR status
    }
  });
  ipcMain.handle("github.deviceStart", () => github.deviceStart());
  ipcMain.handle("github.deviceWait", () => github.deviceWait());
  ipcMain.handle("github.deviceCancel", () => github.deviceCancel());
  ipcMain.handle("github.disconnect", () => github.disconnect());
  // One-click publish: create the repo → attach origin → push (partial outcomes
  // stay honest — see publishToGitHub).
  ipcMain.handle("github.publishRepo", (_e, workspacePath: string, input: unknown) => {
    if (!allowWorkspace(workspacePath)) return { ok: false, error: "Папка не открыта в приложении." };
    const i = input as { name?: unknown; private?: unknown };
    if (typeof i?.name !== "string" || !i.name.trim()) {
      return { ok: false, error: "Укажите имя репозитория." };
    }
    return publishToGitHub(workspacePath, {
      name: i.name.trim(),
      private: i.private !== false,
      push: true,
    });
  });
  ipcMain.handle("github.prContext", async (_e, workspacePath: string) => {
    const empty = {
      owner: null,
      repo: null,
      defaultBranch: null,
      remoteBranches: [],
      head: null,
      lastSubject: null,
      ahead: 0,
    };
    if (!allowWorkspace(workspacePath)) return { ...empty, error: "Папка не открыта в приложении." };
    const [sync, list, subject] = await Promise.all([
      gitService.syncInfo(workspacePath),
      gitService.listBranches(workspacePath),
      gitService.lastCommitSubject(workspacePath),
    ]);
    const ref = sync.remote ? parseGitHubRemote(sync.remote) : null;
    let defBranch: string | null = null;
    let remotes = await gitService.remoteBranches(workspacePath);
    if (ref) {
      try {
        defBranch = await github.defaultBranch(ref.owner, ref.repo);
        if (defBranch && !remotes.includes(defBranch)) remotes = [defBranch, ...remotes];
      } catch {
        defBranch = remotes.includes("main") ? "main" : (remotes[0] ?? null);
      }
    }
    return {
      owner: ref?.owner ?? null,
      repo: ref?.repo ?? null,
      defaultBranch: defBranch,
      remoteBranches: remotes,
      head: list.current,
      lastSubject: subject,
      ahead: sync.ahead,
    };
  });
  ipcMain.handle("github.createPr", async (_e, workspacePath: string, input: unknown) => {
    if (!allowWorkspace(workspacePath)) return { ok: false, error: "Папка не открыта в приложении." };
    const i = input as { title?: unknown; body?: unknown; head?: unknown; base?: unknown; draft?: unknown };
    if (
      typeof i?.title !== "string" ||
      !i.title.trim() ||
      typeof i?.head !== "string" ||
      typeof i?.base !== "string"
    ) {
      return { ok: false, error: "Заполните заголовок и ветки." };
    }
    const sync = await gitService.syncInfo(workspacePath);
    if (!sync.remote) return { ok: false, error: "У репозитория нет origin." };
    // Unpushed commits first — the PR must see the branch as it is here.
    if (sync.ahead > 0 || !sync.upstream) {
      const pushed = await gitService.push(workspacePath, await gitNetEnv());
      if (!pushed.ok) return { ok: false, error: pushed.stderr || "Не удалось отправить ветку." };
    }
    return github.createPull(sync.remote, {
      title: i.title.trim(),
      body: typeof i.body === "string" ? i.body : "",
      head: i.head,
      base: i.base,
      draft: i.draft !== false,
    });
  });
  ipcMain.handle(
    "github.prText",
    async (_e, workspacePath: string, base: string, model: string) => {
      if (!allowWorkspace(workspacePath) || typeof base !== "string") return null;
      const key = await getApiKey();
      if (!key) return null;
      const { subjects, diff } = await gitService.rangeSummary(workspacePath, base);
      if (subjects.length === 0 && !diff.trim()) return null;
      const context = `Коммиты ветки:\n${subjects.map((s) => `- ${s}`).join("\n")}\n\nДифф:\n${diff}`;
      const prefs = await loadSettings();
      return generatePrText(
        key,
        context,
        typeof model === "string" && model ? model : "claude-sonnet-5",
        prefs.gitPrInstructions,
      );
    },
  );

  // --- Change review (dispatched: git repo → git; plain folder → snapshot) ----
  ipcMain.handle("review.summary", (_e, workspacePath: string, taskId: string) =>
    allowWorkspace(workspacePath)
      ? reviewService.summary(workspacePath, taskId)
      : { isRepo: false, backing: "none", files: [], additions: 0, deletions: 0 },
  );
  ipcMain.handle("review.diff", (_e, workspacePath: string, taskId: string, file: string) =>
    allowWorkspace(workspacePath)
      ? reviewService.diff(workspacePath, taskId, file)
      : { diff: "", untracked: false },
  );
  ipcMain.handle("review.revertFile", (_e, workspacePath: string, taskId: string, file: string) => {
    if (allowWorkspace(workspacePath)) return reviewService.revertFile(workspacePath, taskId, file);
  });
  ipcMain.handle("review.revertAll", (_e, workspacePath: string, taskId: string) => {
    if (allowWorkspace(workspacePath)) return reviewService.revertAll(workspacePath, taskId);
  });
  ipcMain.handle("review.forget", (_e, taskId: string) => snapshot.forget(taskId));

  // --- Live preview (loopback static server framed in the inspector) ----------
  ipcMain.handle("preview.start", async (_e, workspacePath: string) => {
    if (!allowWorkspace(workspacePath)) return { error: "workspace_not_allowed" };
    const found = resolvePreviewRoot(workspacePath);
    if (!found) return { error: "no_index" };
    await stopPreview();
    const handle = await previewServer.start(found.root, found.entry);
    previewDispose = watchPreview(found.root, () => {
      mainWindow?.webContents.send("preview.changed");
    });
    return { url: handle.url, entry: handle.entry };
  });
  ipcMain.handle("preview.stop", () => stopPreview());
  ipcMain.handle("preview.resolveRoot", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath) ? resolvePreviewRoot(workspacePath) : null,
  );

  // --- Native preview browser (WebContentsView over the pane's rectangle) ----
  // The renderer sends geometry + the url it wants; navigation inside the page
  // (link clicks, redirects) belongs to the view and never fights the app.
  ipcMain.handle("previewview.show", (_e, rawBounds: unknown, url: unknown, device: unknown) => {
    if (!mainWindow) return;
    const rb = (rawBounds ?? {}) as Record<string, unknown>;
    const b: PreviewViewBounds = {
      x: Number(rb.x),
      y: Number(rb.y),
      width: Number(rb.width),
      height: Number(rb.height),
    };
    if (![b.x, b.y, b.width, b.height].every(Number.isFinite)) return;
    const dev: PreviewDevice = device === "mobile" || device === "tablet" ? device : "desktop";
    previewViewShow(mainWindow, b, typeof url === "string" ? url : null, dev);
  });
  ipcMain.handle("previewview.hide", () => previewViewHide());
  ipcMain.handle("previewview.destroy", () => previewViewDestroy());
  ipcMain.handle("previewview.back", () => previewViewBack());
  ipcMain.handle("previewview.forward", () => previewViewForward());
  ipcMain.handle("previewview.reload", () => previewViewReload());
  // Screenshot of the live preview surface, saved so the agent can Read it.
  ipcMain.handle("previewview.capture", async () => {
    const png = await previewViewCapture();
    return png ? saveImageBuffer(png, "png", "shot") : null;
  });

  // --- Dev server (framework `npm run dev` framed in the preview) --------------
  ipcMain.handle("devserver.detect", (_e, workspacePath: string) => {
    if (!allowWorkspace(workspacePath)) return [];
    try {
      const pkg = JSON.parse(readFileSync(join(workspacePath, "package.json"), "utf8"));
      return detectDevScripts(pkg);
    } catch {
      return [];
    }
  });
  ipcMain.handle(
    "devserver.start",
    (_e, input: { workspacePath: string; script: string; defaultPort: number }) => {
      if (!allowWorkspace(input.workspacePath)) {
        return { id: "", workspacePath: input.workspacePath, status: "crashed" as const };
      }
      return devServers.start(input.workspacePath, input.script, input.defaultPort);
    },
  );
  ipcMain.handle("devserver.stop", (_e, id: string) => devServers.stop(id));
  ipcMain.handle("devserver.get", (_e, workspacePath: string) =>
    allowWorkspace(workspacePath) ? devServers.getState(workspacePath) : null,
  );

  // --- Terminal (persistent shell session per panel) --------------------------
  ipcMain.handle("terminal.create", (_e, cwd: string) =>
    allowWorkspace(cwd) ? terminals.create(cwd) : null,
  );
  ipcMain.handle("terminal.write", (_e, id: string, data: string) => terminals.write(id, data));
  ipcMain.handle("terminal.kill", (_e, id: string) => terminals.kill(id));
}

function createWindow(): void {
  // A fresh window gets a fresh close guard: on macOS the app survives a
  // confirmed close (dock re-activate recreates the window), and a stale
  // `true` here would silently kill the next mid-run generation.
  closeConfirmed = false;
  const saved = loadWindowBounds();
  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x !== undefined && saved.y !== undefined ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#151515",
    autoHideMenuBar: true,
    // Window/taskbar icon. A packaged Windows build takes its icon from the .exe
    // resources instead, so this mainly fixes dev (where the window would otherwise
    // show Electron's default) and any platform without an embedded icon. Resolved
    // like the bundled skills: two levels up from out/main, i.e. apps/desktop/resources
    // in dev and resources/app/resources once packaged.
    icon: join(import.meta.dirname, "..", "..", "resources", "icon.png"),
    // Frameless-with-native-buttons: the caption is hidden and the app draws one
    // unified 40px header, while the OS keeps its own window controls on top, so
    // Snap Layouts (Windows) and edge-resize stay native.
    //
    // The two platforms put those controls on OPPOSITE sides. Windows overlays
    // min/max/close on the right and reports the reserved area to CSS via
    // env(titlebar-area-*); its colours start dark and are re-synced from the
    // renderer on theme change (chrome.setOverlay). macOS puts the three traffic
    // lights top LEFT, which is where our sidebar/search/navigation cluster sits —
    // so we centre them in the 40px bar here, and the renderer reserves the width
    // (see [data-platform="mac"] .titlebar). macOS has no window-controls-overlay
    // API, so env(titlebar-area-height) is undefined there and the 40px fallback
    // already baked into those rules is the correct value.
    ...(process.platform === "win32"
      ? {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: "#202020", symbolColor: "#b4b4b4", height: 40 },
        }
      : {}),
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hidden" as const,
          // 12px buttons centred in a 40px bar: (40 - 12) / 2 = 14.
          trafficLightPosition: { x: 13, y: 14 },
        }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });
  mainWindow = win;
  if (saved.maximized) win.maximize();
  trackWindowBounds(win);

  win.once("ready-to-show", () => win.show());
  // Closing mid-generation loses the undelivered answer (and its spend): hold the
  // close once and let the renderer confirm. Skipped when nothing runs, after the
  // user confirmed, or when the renderer can't answer anymore (crash/hang) — the
  // window must never become unclosable.
  win.on("close", (event) => {
    if (closeConfirmed || !runtime.hasActive()) return;
    if (win.webContents.isDestroyed() || win.webContents.isCrashed()) return;
    event.preventDefault();
    win.webContents.send("app.closeRequested");
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    previewViewDestroy();
    void stopPreview();
  });
  // Stop the taskbar flash once the user is looking at the window again.
  win.on("focus", () => win.flashFrame(false));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!rendererUrl || !url.startsWith(rendererUrl)) event.preventDefault();
  });

  if (rendererUrl) {
    void win.loadURL(rendererUrl);
  } else {
    void win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  // No native menu bar: Alt must not summon File/Edit/View over our own chrome.
  // (macOS keeps the app menu — the platform requires one for Cmd+C/V etc.)
  if (process.platform !== "darwin") Menu.setApplicationMenu(null);

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    let host = "";
    try {
      host = new URL(details.url).hostname;
    } catch {
      /* non-URL scheme — fall through to the app CSP */
    }
    if (host === "127.0.0.1" || host === "localhost") {
      // Local preview/dev servers: pass their headers through UNCHANGED except
      // stripping anti-framing headers, and never impose the app's own
      // `default-src 'self'` CSP. (Legacy of the iframe preview — the native
      // WebContentsView runs on its own session and doesn't need this; kept
      // because it's harmless and other local embeds may rely on it.)
      const headers = { ...details.responseHeaders };
      for (const key of Object.keys(headers)) {
        if (/^(x-frame-options|content-security-policy|content-security-policy-report-only)$/i.test(key)) {
          delete headers[key];
        }
      }
      callback({ responseHeaders: headers });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [contentSecurityPolicy()],
      },
    });
  });
  // Deny every renderer permission except writing to the clipboard — Chromium
  // gates navigator.clipboard.writeText behind it, and a blanket deny silently
  // broke the "copy answer" button.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === "clipboard-sanitized-write"),
  );

  // Mirror the notification preference so the event handler reads it sync.
  void loadSettings().then((s) => {
    notificationsEnabled = s.notifications !== false;
  });

  registerIpc();
  createWindow();

  initUpdater((status) => mainWindow?.webContents.send("update.changed", status));
  // Check a little after launch rather than during it: startup is already busy,
  // and a version check is never urgent. Re-check every six hours so a session
  // left open for days still learns about a release. `.unref()` keeps the timer
  // from holding the process alive on quit.
  setTimeout(() => void checkForUpdates(), 10_000).unref();
  setInterval(() => void checkForUpdates(), 6 * 60 * 60 * 1000).unref();

  void cleanupPastes();
  // Sweep again on a timer so a session left open for days doesn't accumulate
  // pasted images unbounded (each is up to 10 MB). `.unref()` keeps it from
  // holding the process alive on quit.
  setInterval(() => void cleanupPastes(), 6 * 60 * 60 * 1000).unref();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  runtime.cancelAll();
  void stopPreview();
  devServers.killAll();
  terminals.killAll();
  if (process.platform !== "darwin") app.quit();
});

// Reap agent / dev-server / terminal process trees on quit so nothing orphans —
// the SDK abort kills its `claude` subprocess along with the run. On macOS
// Cmd+Q fires before-quit BEFORE any window close, so the mid-run confirmation
// must hold the QUIT itself — killing the runs first and asking afterwards
// would be a lie. (On Windows the window's close handler asks first anyway.)
app.on("before-quit", (event) => {
  if (
    !closeConfirmed &&
    runtime.hasActive() &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed() &&
    !mainWindow.webContents.isCrashed()
  ) {
    event.preventDefault();
    mainWindow.webContents.send("app.closeRequested");
    return;
  }
  runtime.cancelAll();
  void stopPreview();
  devServers.killAll();
  terminals.killAll();
});
