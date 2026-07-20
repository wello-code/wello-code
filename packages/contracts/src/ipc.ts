/**
 * The concrete, typed IPC surface between renderer (via preload) and main. We use a
 * fixed registry of named verbs — never a generic `invoke(name, payload)`,
 * `exec(command)` or `filesystem(path)` channel (ARCHITECTURE.md §4, DATA_AND_EVENTS.md §8).
 *
 * Channel names are grouped by domain. Payload/response schemas are added per verb as
 * each capability lands; the preload validates against them before crossing the boundary.
 */
export const IPC = {
  workspace: {
    open: "workspace.open",
    close: "workspace.close",
    getTree: "workspace.getTree",
    search: "workspace.search",
  },
  task: {
    create: "task.create",
    list: "task.list",
    update: "task.update",
    archive: "task.archive",
  },
  agent: {
    start: "agent.start",
    cancel: "agent.cancel",
    pause: "agent.pause",
    resume: "agent.resume",
    reply: "agent.reply",
    /** Push channel: main streams AgentEvent payloads to the renderer. */
    events: "agent.events",
  },
  permissions: {
    list: "permissions.list",
    respond: "permissions.respond",
    revokeRule: "permissions.revokeRule",
  },
  questions: {
    respond: "questions.respond",
  },
  changes: {
    get: "changes.get",
    apply: "changes.apply",
    revert: "changes.revert",
    restoreCheckpoint: "changes.restoreCheckpoint",
  },
  terminal: {
    create: "terminal.create",
    write: "terminal.write",
    resize: "terminal.resize",
    close: "terminal.close",
    /** Push channel: main streams terminal output chunks to the renderer. */
    data: "terminal.data",
  },
  git: {
    status: "git.status",
    diff: "git.diff",
    stage: "git.stage",
    unstage: "git.unstage",
    createWorktree: "git.createWorktree",
  },
  settings: {
    get: "settings.get",
    set: "settings.set",
  },
  layout: {
    restore: "layout.restore",
    persist: "layout.persist",
  },
} as const;

type ValuesOf<T> = T[keyof T];

/** Union of every valid IPC channel string (e.g. "agent.start" | "git.status" | ...). */
export type IpcChannel = ValuesOf<{
  [Group in keyof typeof IPC]: ValuesOf<(typeof IPC)[Group]>;
}>;
