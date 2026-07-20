import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { DevServerEvent, DevServerState } from "../shared/ipc-api";
import { detectPackageManager, scrapeDevUrl } from "./dev-scripts";

/**
 * Runs a workspace's dev server (npm/pnpm/yarn/bun run <script>) for the preview
 * pane. Consent-gated (started only on an explicit click), spawned with a clean
 * token-free env, and — critically — killed as a whole PROCESS TREE on stop/quit so
 * esbuild/node grandchildren don't orphan and hold the port. Mirrors AgentRuntime.
 */

const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"];

interface Running {
  id: string;
  workspacePath: string;
  child: ChildProcess;
  status: DevServerState["status"];
  url?: string;
  port?: number;
  settled: boolean;
}

export class DevServerManager {
  private readonly byPath = new Map<string, Running>();

  constructor(private readonly emit: (event: DevServerEvent) => void) {}

  getState(workspacePath: string): DevServerState | null {
    const r = this.byPath.get(workspacePath);
    return r ? this.stateOf(r) : null;
  }

  private stateOf(r: Running): DevServerState {
    return { id: r.id, workspacePath: r.workspacePath, status: r.status, url: r.url, port: r.port };
  }

  private publish(r: Running, logLine?: string): void {
    this.emit({ ...this.stateOf(r), ...(logLine ? { logLine } : {}) });
  }

  /** Start `script` (must be a real key in package.json) as a dev server. */
  start(workspacePath: string, script: string, defaultPort: number): DevServerState {
    // Reuse a live server for this folder rather than spawning a duplicate.
    const existing = this.byPath.get(workspacePath);
    if (existing && existing.status !== "crashed" && existing.status !== "stopped") {
      return this.stateOf(existing);
    }

    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(join(workspacePath, "package.json"), "utf8"));
    } catch {
      return this.crashedStub(workspacePath, "package.json не читается");
    }
    // Never run free-form input: the script MUST be a developer-authored key.
    if (!pkg.scripts || !(script in pkg.scripts)) {
      return this.crashedStub(workspacePath, "Скрипт не найден в package.json");
    }
    const pm = detectPackageManager(LOCKFILES.filter((f) => existsSync(join(workspacePath, f))));
    const child = spawn(pm, ["run", script], {
      cwd: workspacePath,
      // Clean env — NEVER the SDK's token-injected env. Suppress auto-open + color.
      env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0", NO_COLOR: "1", CI: "1" },
      windowsHide: true,
      shell: process.platform === "win32",
      // posix: own process group so killTree's process.kill(-pid) reaps grandchildren
      // (esbuild/node). win32 uses taskkill /t instead, no detached needed.
      detached: process.platform !== "win32",
    });
    const r: Running = { id: randomUUID(), workspacePath, child, status: "starting", settled: false };
    this.byPath.set(workspacePath, r);
    this.publish(r);

    const onLine = (line: string): void => {
      if (!line.trim()) return;
      this.publish(r, line.slice(0, 500));
      const hit = scrapeDevUrl(line);
      if (hit) this.markListening(r, hit.host, hit.port);
    };
    lineReader(child, onLine);

    // Race the stdout scrape with a plain port probe (default port), since some
    // servers barely log — whichever confirms first wins.
    void this.waitForPort(defaultPort, r).then((open) => {
      if (open) this.markListening(r, "127.0.0.1", defaultPort);
    });

    child.on("error", () => this.markTerminal(r, "crashed"));
    child.on("exit", (code) => {
      if (r.status === "listening" || r.status === "starting") {
        this.markTerminal(r, code && code !== 0 ? "crashed" : "stopped", code ?? undefined);
      }
    });
    return this.stateOf(r);
  }

  private markListening(r: Running, host: string, port: number): void {
    if (r.settled || r.status !== "starting") return;
    r.settled = true;
    r.status = "listening";
    r.port = port;
    r.url = `http://${host === "0.0.0.0" || host === "[::1]" ? "127.0.0.1" : host}:${port}/`;
    this.publish(r);
  }

  private markTerminal(r: Running, status: "crashed" | "stopped", exitCode?: number): void {
    r.status = status;
    r.settled = true;
    this.emit({ ...this.stateOf(r), ...(exitCode != null ? { exitCode } : {}) });
    this.byPath.delete(r.workspacePath);
  }

  private crashedStub(workspacePath: string, reason: string): DevServerState {
    const state: DevServerState = { id: randomUUID(), workspacePath, status: "crashed" };
    this.emit({ ...state, logLine: reason });
    return state;
  }

  /** net.connect poll until the port accepts a connection, the child dies, or timeout. */
  private waitForPort(port: number, r: Running, timeoutMs = 90_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      const attempt = (): void => {
        if (r.settled || r.status === "crashed" || r.status === "stopped") return resolve(false);
        if (Date.now() > deadline) return resolve(false);
        const sock = connect({ port, host: "127.0.0.1" });
        sock.setTimeout(1000);
        sock.once("connect", () => {
          sock.destroy();
          resolve(true);
        });
        const retry = (): void => {
          sock.destroy();
          setTimeout(attempt, 400);
        };
        sock.once("error", retry);
        sock.once("timeout", retry);
      };
      attempt();
    });
  }

  stop(id: string): void {
    for (const r of this.byPath.values()) {
      if (r.id === id) {
        this.killTree(r.child);
        this.markTerminal(r, "stopped");
        return;
      }
    }
  }

  killAll(): void {
    for (const r of this.byPath.values()) this.killTree(r.child);
    this.byPath.clear();
  }

  /** Kill the whole tree — dev servers fork grandchildren that hold the port. */
  private killTree(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => undefined);
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
  }
}

/** Emit each complete stdout/stderr line to `onLine` (best-effort). */
function lineReader(child: ChildProcess, onLine: (line: string) => void): void {
  const feed = (buf: Buffer): void => {
    for (const line of buf.toString("utf8").split(/\r?\n/)) onLine(line);
  };
  child.stdout?.on("data", feed);
  child.stderr?.on("data", feed);
}
