import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AgentEvent, PermissionDecision, QuestionAnswer } from "@wello-code/contracts";
import type {
  AppInfo,
  AppSettings,
  Connection,
  StartRunInput,
  WelloApi,
  WorkspaceInfo,
} from "../shared/ipc-api";

/**
 * The ONLY bridge between the sandboxed renderer and main. Every method is a named,
 * typed verb over a fixed IPC channel — never a generic invoke/exec/readFile/fetch.
 */
const api: WelloApi = {
  ping: () => ipcRenderer.invoke("app.ping") as Promise<"pong">,
  getAppInfo: () => ipcRenderer.invoke("app.getInfo") as Promise<AppInfo>,
  showLog: () => ipcRenderer.invoke("app.showLog") as Promise<void>,
  openExternal: (url) => ipcRenderer.invoke("app.openExternal", url) as Promise<void>,
  setTitleBarOverlay: (opts) => ipcRenderer.invoke("chrome.setOverlay", opts) as Promise<void>,
  onCloseRequested: (handler: () => void) => {
    const listener = (): void => handler();
    ipcRenderer.on("app.closeRequested", listener);
    return () => ipcRenderer.removeListener("app.closeRequested", listener);
  },
  confirmClose: () => ipcRenderer.invoke("app.confirmClose") as Promise<void>,
  minimizeWindow: () => ipcRenderer.invoke("app.minimize") as Promise<void>,
  revealWorkspace: (dir) => ipcRenderer.invoke("workspace.reveal", dir) as Promise<void>,

  setApiKey: (key) => ipcRenderer.invoke("wello.setApiKey", key) as Promise<Connection>,
  signInViaBrowser: () => ipcRenderer.invoke("wello.signInViaBrowser") as Promise<Connection>,
  cancelBrowserSignIn: () => ipcRenderer.invoke("wello.cancelBrowserSignIn") as Promise<void>,
  getConnection: () => ipcRenderer.invoke("wello.getConnection") as Promise<Connection>,
  setPaygOverflow: (enabled) =>
    ipcRenderer.invoke("wello.setPaygOverflow", enabled) as Promise<Connection>,
  clearApiKey: () => ipcRenderer.invoke("wello.clearApiKey") as Promise<void>,

  openWorkspace: () => ipcRenderer.invoke("workspace.open") as Promise<WorkspaceInfo | null>,
  getWorkspaceTrust: (path: string) => ipcRenderer.invoke("workspace.getTrust", path),
  setWorkspaceTrust: (path: string, trusted: boolean) =>
    ipcRenderer.invoke("workspace.setTrust", path, trusted) as Promise<void>,
  clearWorkspaceGrants: (path: string) =>
    ipcRenderer.invoke("workspace.clearGrants", path) as Promise<void>,
  workspaceInstructions: (path: string) =>
    ipcRenderer.invoke("workspace.instructions", path) as Promise<{ file: string | null }>,

  loadState: () => ipcRenderer.invoke("state.load"),
  saveState: (state) => ipcRenderer.invoke("state.save", state) as Promise<void>,

  getSettings: () => ipcRenderer.invoke("settings.get") as Promise<AppSettings>,
  setSettings: (settings: AppSettings) => ipcRenderer.invoke("settings.set", settings) as Promise<void>,
  listUserSkills: () => ipcRenderer.invoke("userSkills.list"),
  openUserSkillsFolder: () => ipcRenderer.invoke("userSkills.openFolder") as Promise<void>,
  listProjectCommands: (workspacePath: string) =>
    ipcRenderer.invoke("commands.list", workspacePath),
  pickFolder: (title: string) => ipcRenderer.invoke("dialog.pickFolder", title) as Promise<string | null>,
  pickFiles: (title: string) => ipcRenderer.invoke("dialog.pickFiles", title) as Promise<string[]>,

  savePastedImage: (data: ArrayBuffer, mime: string) =>
    ipcRenderer.invoke("paste.saveImage", data, mime) as Promise<string | null>,
  readImageData: (path: string) =>
    ipcRenderer.invoke("media.readImage", path) as Promise<string | null>,
  statPaths: (paths: string[]) => ipcRenderer.invoke("media.statPaths", paths),
  copyText: (text: string) => ipcRenderer.invoke("clipboard.copyText", text) as Promise<void>,
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },

  readWorkspaceFile: (workspacePath, file) => ipcRenderer.invoke("file.read", workspacePath, file),
  openWorkspaceFile: (workspacePath, file) =>
    ipcRenderer.invoke("file.openInSystem", workspacePath, file) as Promise<void>,
  listWorkspaceFiles: (workspacePath) =>
    ipcRenderer.invoke("file.list", workspacePath) as Promise<string[]>,

  generateTitle: (prompt: string) => ipcRenderer.invoke("title.generate", prompt) as Promise<string | null>,
  exportChat: (name: string, content: string) =>
    ipcRenderer.invoke("chat.export", name, content) as Promise<boolean>,
  generateHandoff: (transcript: string, model: string) =>
    ipcRenderer.invoke("chat.handoff", transcript, model) as Promise<string | null>,

  startRun: (input: StartRunInput) => ipcRenderer.invoke("agent.start", input) as Promise<void>,
  cancelRun: (runId) => ipcRenderer.invoke("agent.cancel", runId) as Promise<void>,
  checkpointExists: (taskId, turnId) =>
    ipcRenderer.invoke("checkpoint.has", taskId, turnId) as Promise<boolean>,
  restoreCheckpoint: (taskId, turnId, workspacePath) =>
    ipcRenderer.invoke("checkpoint.restore", taskId, turnId, workspacePath) as Promise<boolean>,
  respondPermission: (requestId, decision: PermissionDecision) =>
    ipcRenderer.invoke("permissions.respond", { requestId, decision }) as Promise<void>,
  respondQuestion: (answer: QuestionAnswer) =>
    ipcRenderer.invoke("questions.respond", answer) as Promise<void>,

  gitStatus: (workspacePath) => ipcRenderer.invoke("git.status", workspacePath),
  gitDiff: (workspacePath, file) => ipcRenderer.invoke("git.diff", workspacePath, file),
  gitRevertFile: (workspacePath, file) =>
    ipcRenderer.invoke("git.revertFile", workspacePath, file) as Promise<void>,
  gitChangeSummary: (workspacePath) => ipcRenderer.invoke("git.changeSummary", workspacePath),
  gitBranchInfo: (workspacePath) => ipcRenderer.invoke("git.branchInfo", workspacePath),
  gitCommitAll: (workspacePath, message) =>
    ipcRenderer.invoke("git.commitAll", workspacePath, message),
  gitInit: (workspacePath, taskId) => ipcRenderer.invoke("git.init", workspacePath, taskId),
  gitCommitMessage: (diff, model) =>
    ipcRenderer.invoke("git.commitMessage", diff, model) as Promise<string | null>,
  gitSyncInfo: (workspacePath) => ipcRenderer.invoke("git.syncInfo", workspacePath),
  gitFetch: (workspacePath) => ipcRenderer.invoke("git.fetch", workspacePath),
  gitPush: (workspacePath) => ipcRenderer.invoke("git.push", workspacePath),
  gitPull: (workspacePath) => ipcRenderer.invoke("git.pull", workspacePath),
  gitListBranches: (workspacePath) => ipcRenderer.invoke("git.listBranches", workspacePath),
  gitSwitchBranch: (workspacePath, name) =>
    ipcRenderer.invoke("git.switchBranch", workspacePath, name),
  gitCreateBranch: (workspacePath, name) =>
    ipcRenderer.invoke("git.createBranch", workspacePath, name),
  gitAddRemote: (workspacePath, url) => ipcRenderer.invoke("git.addRemote", workspacePath, url),
  gitCheckoutRemote: (workspacePath, name) =>
    ipcRenderer.invoke("git.checkoutRemote", workspacePath, name),
  gitRenameBranch: (workspacePath, from, to) =>
    ipcRenderer.invoke("git.renameBranch", workspacePath, from, to),
  gitDeleteBranch: (workspacePath, name, force) =>
    ipcRenderer.invoke("git.deleteBranch", workspacePath, name, force),
  gitStashPush: (workspacePath) => ipcRenderer.invoke("git.stashPush", workspacePath),
  gitStashPop: (workspacePath) => ipcRenderer.invoke("git.stashPop", workspacePath),
  gitStashCount: (workspacePath) => ipcRenderer.invoke("git.stashCount", workspacePath),
  gitRemoteBranches: (workspacePath) => ipcRenderer.invoke("git.remoteBranches", workspacePath),
  gitConflictInfo: (workspacePath) => ipcRenderer.invoke("git.conflictInfo", workspacePath),
  gitAbortConflict: (workspacePath) => ipcRenderer.invoke("git.abortConflict", workspacePath),
  githubStatus: () => ipcRenderer.invoke("github.status"),
  githubPullForBranch: (workspacePath, branch) =>
    ipcRenderer.invoke("github.pullForBranch", workspacePath, branch),
  githubDeviceStart: () => ipcRenderer.invoke("github.deviceStart"),
  githubDeviceWait: () => ipcRenderer.invoke("github.deviceWait"),
  githubDeviceCancel: () => ipcRenderer.invoke("github.deviceCancel") as Promise<void>,
  githubDisconnect: () => ipcRenderer.invoke("github.disconnect") as Promise<void>,
  githubPublishRepo: (workspacePath, input) =>
    ipcRenderer.invoke("github.publishRepo", workspacePath, input),
  respondGithubConnect: (requestId, connected) =>
    ipcRenderer.invoke("github.respondConnect", requestId, connected) as Promise<void>,
  githubPrContext: (workspacePath) => ipcRenderer.invoke("github.prContext", workspacePath),
  githubCreatePr: (workspacePath, input) =>
    ipcRenderer.invoke("github.createPr", workspacePath, input),
  githubPrText: (workspacePath, base, model) =>
    ipcRenderer.invoke("github.prText", workspacePath, base, model) as Promise<{
      title: string;
      body: string;
    } | null>,
  gitValidateBranchPrefix: (prefix) => ipcRenderer.invoke("git.validatePrefix", prefix),

  reviewSummary: (workspacePath, taskId) =>
    ipcRenderer.invoke("review.summary", workspacePath, taskId),
  reviewDiff: (workspacePath, taskId, file) =>
    ipcRenderer.invoke("review.diff", workspacePath, taskId, file),
  reviewRevertFile: (workspacePath, taskId, file) =>
    ipcRenderer.invoke("review.revertFile", workspacePath, taskId, file) as Promise<void>,
  reviewRevertAll: (workspacePath, taskId) =>
    ipcRenderer.invoke("review.revertAll", workspacePath, taskId) as Promise<void>,
  reviewForget: (taskId) => ipcRenderer.invoke("review.forget", taskId) as Promise<void>,

  startPreview: (workspacePath) => ipcRenderer.invoke("preview.start", workspacePath),
  stopPreview: () => ipcRenderer.invoke("preview.stop") as Promise<void>,
  resolvePreviewRoot: (workspacePath) => ipcRenderer.invoke("preview.resolveRoot", workspacePath),
  onPreviewChange: (handler: () => void) => {
    const listener = (): void => handler();
    ipcRenderer.on("preview.changed", listener);
    return () => ipcRenderer.removeListener("preview.changed", listener);
  },
  previewViewShow: (bounds, url, device) =>
    ipcRenderer.invoke("previewview.show", bounds, url, device) as Promise<void>,
  previewViewHide: () => ipcRenderer.invoke("previewview.hide") as Promise<void>,
  previewViewDestroy: () => ipcRenderer.invoke("previewview.destroy") as Promise<void>,
  previewViewBack: () => ipcRenderer.invoke("previewview.back") as Promise<void>,
  previewViewForward: () => ipcRenderer.invoke("previewview.forward") as Promise<void>,
  previewViewReload: () => ipcRenderer.invoke("previewview.reload") as Promise<void>,
  previewViewCapture: () => ipcRenderer.invoke("previewview.capture") as Promise<string | null>,
  onPreviewViewState: (handler) => {
    const listener = (_e: unknown, state: unknown): void => handler(state as never);
    ipcRenderer.on("previewview.state", listener);
    return () => ipcRenderer.removeListener("previewview.state", listener);
  },

  detectDevScripts: (workspacePath) => ipcRenderer.invoke("devserver.detect", workspacePath),
  startDevServer: (input) => ipcRenderer.invoke("devserver.start", input),
  stopDevServer: (id) => ipcRenderer.invoke("devserver.stop", id) as Promise<void>,
  getDevServer: (workspacePath) => ipcRenderer.invoke("devserver.get", workspacePath),
  onDevServerEvent: (handler) => {
    const listener = (_e: unknown, event: unknown): void => handler(event as never);
    ipcRenderer.on("devserver.events", listener);
    return () => ipcRenderer.removeListener("devserver.events", listener);
  },

  createTerminal: (cwd) => ipcRenderer.invoke("terminal.create", cwd),
  writeTerminal: (id, data) => ipcRenderer.invoke("terminal.write", id, data) as Promise<void>,
  killTerminal: (id) => ipcRenderer.invoke("terminal.kill", id) as Promise<void>,
  onTerminalData: (handler) => {
    const listener = (_e: unknown, event: unknown): void => handler(event as never);
    ipcRenderer.on("terminal.data", listener);
    return () => ipcRenderer.removeListener("terminal.data", listener);
  },
  onTerminalExit: (handler) => {
    const listener = (_e: unknown, event: unknown): void => handler(event as never);
    ipcRenderer.on("terminal.exit", listener);
    return () => ipcRenderer.removeListener("terminal.exit", listener);
  },

  onAgentEvent: (handler: (event: AgentEvent) => void) => {
    const listener = (_event: unknown, payload: AgentEvent): void => handler(payload);
    ipcRenderer.on("agent.events", listener);
    return () => ipcRenderer.removeListener("agent.events", listener);
  },
};

contextBridge.exposeInMainWorld("wello", api);
