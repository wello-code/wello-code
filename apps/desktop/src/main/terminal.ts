import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

/**
 * Windows cmd.exe writes its output (including the startup banner) in the console
 * OEM code page — CP866 on Russian Windows, 850/437 on Western, etc. Decoding those
 * bytes as UTF-8 turns Cyrillic into mojibake ("Ð‘Ð°Ð·Ð°"). We detect the actual OEM
 * page once via `chcp` and decode with the matching TextDecoder label; anything we
 * can't map falls back to UTF-8. On non-Windows the shell is already UTF-8.
 */
const OEM_DECODER_LABEL = detectOemDecoderLabel();

function detectOemDecoderLabel(): string {
  if (process.platform !== "win32") return "utf-8";
  try {
    // `chcp` prints e.g. "Active code page: 866" (or a localized variant + number).
    const out = execFileSync("chcp.com", { windowsHide: true, timeout: 2000 }).toString("latin1");
    const cp = Number(out.match(/(\d{3,5})/)?.[1] ?? 0);
    const map: Record<number, string> = {
      65001: "utf-8",
      866: "ibm866",
      850: "ibm850",
      437: "ibm437",
      1250: "windows-1250",
      1251: "windows-1251",
      1252: "windows-1252",
    };
    const label = map[cp] ?? "utf-8";
    // Verify the runtime actually supports this label (full-ICU builds do); else UTF-8.
    new TextDecoder(label);
    return label;
  } catch {
    return "utf-8";
  }
}

/** A fresh streaming decoder for one stdio stream (handles multibyte splits across chunks). */
function makeStreamDecode(): (buf: Buffer) => string {
  try {
    const dec = new TextDecoder(OEM_DECODER_LABEL);
    return (buf) => dec.decode(buf, { stream: true });
  } catch {
    return (buf) => buf.toString("utf8");
  }
}

/**
 * Index where an UNTERMINATED escape sequence starts at the tail of `s`, or -1
 * when the string ends on a sequence boundary. Scans left-to-right (a trailing
 * ESC may legitimately live INSIDE an unterminated OSC — ESC\ is its terminator
 * — so a naive lastIndexOf would cut in the wrong place). Oversized sequences
 * (runaway CSI > 1 KB / OSC > 8 KB) report -1: give up holding, ship as-is.
 *
 * Why here (main, per stream): stdout and stderr are SEPARATE pipes funneled
 * into one renderer buffer. If a chunk ends mid-escape, the *other* stream's
 * chunk may arrive next and get glued onto the dangling sequence, garbling
 * both. Holding the incomplete tail per stream keeps every forwarded chunk on
 * a sequence boundary, so interleaving can never split an escape.
 */
export function incompleteEscapeStart(s: string): number {
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "\x1b") {
      i++;
      continue;
    }
    const start = i;
    if (i + 1 >= s.length) return start; // dangling ESC at the very end
    const kind = s[i + 1]!;
    if (kind === "[") {
      let j = i + 2;
      let done = -1;
      while (j < s.length) {
        const c = s.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          done = j;
          break;
        }
        j++;
      }
      if (done === -1) return j - start > 1024 ? -1 : start;
      i = done + 1;
    } else if (kind === "]") {
      let j = i + 2;
      let done = -1;
      while (j < s.length) {
        if (s[j] === "\x07") {
          done = j;
          break;
        }
        if (s[j] === "\x1b") {
          if (j + 1 >= s.length) return start; // could be the ESC of ESC\
          if (s[j + 1] === "\\") {
            done = j + 1;
            break;
          }
        }
        j++;
      }
      if (done === -1) return j - start > 8192 ? -1 : start;
      i = done + 1;
    } else if (kind === "(" || kind === ")") {
      if (i + 2 >= s.length) return start; // three-byte charset designation
      i += 3;
    } else {
      i += 2; // any other two-byte escape
    }
  }
  return -1;
}

/**
 * Terminal sessions backed by a persistent shell (cmd.exe / bash) with piped stdio.
 * This is the child_process fallback for a real PTY: node-pty needs a native build
 * toolchain (MSVC) that isn't guaranteed on the target, so we ship this — it runs
 * commands, streams output, keeps cwd/env across commands, and reaps the whole
 * process tree on close. Interactive full-screen TUIs (vim) won't work; everyday
 * command work (git, npm, builds) does. Behind the SAME IPC as a pty would use, so
 * swapping in node-pty later is a main-only change.
 */

interface Session {
  id: string;
  child: ChildProcess;
  /** Ships any held-back partial escapes (per stream) before the exit event. */
  flushTails: () => void;
}

export class TerminalManager {
  private readonly byId = new Map<string, Session>();

  constructor(
    private readonly onData: (id: string, data: string) => void,
    private readonly onExit: (id: string, code: number | null) => void,
  ) {}

  /** Start a shell session in `cwd`; returns its id + the shell's short name
   *  ("cmd" / "powershell" / "bash" …) for the renderer's tab title. */
  create(cwd: string): { id: string; shell: string } {
    const id = randomUUID();
    const win = process.platform === "win32";
    const shell = win ? process.env.COMSPEC || "cmd.exe" : process.env.SHELL || "/bin/bash";
    const shellName =
      shell
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.exe$/i, "")
        .toLowerCase() || "shell";
    // Plain cmd with echo ON: a piped cmd prints "<prompt>command" for every line
    // it receives — exactly what a terminal transcript looks like. (The renderer's
    // output view is read-only and does NO local echo; the old "@echo off" write
    // was a leftover that polluted the first prompt and suppressed all later ones.)
    const child = spawn(shell, win ? [] : ["-i"], {
      cwd,
      // The user's own shell env (a terminal is theirs) — but NEVER the SDK's
      // token-injected env. TERM helps tools emit sane ANSI for xterm.js.
      env: { ...process.env, TERM: "xterm-256color", GIT_PAGER: "cat", PAGER: "cat" },
      windowsHide: true,
      detached: !win, // posix: own group so killTree reaps children
    });
    // Decode with the console OEM code page (separate decoder per stream) so Cyrillic
    // output renders correctly instead of UTF-8 mojibake. Each stream also holds
    // back a trailing UNTERMINATED escape sequence until its continuation arrives,
    // so an interleaved chunk from the other stream can never split an escape
    // inside the renderer's single buffer.
    const makeStreamForward = (): { push: (d: Buffer) => void; flush: () => void } => {
      const decode = makeStreamDecode();
      let tail = "";
      return {
        push: (d: Buffer) => {
          const s = tail + decode(d);
          tail = "";
          const cut = incompleteEscapeStart(s);
          if (cut === -1) {
            if (s) this.onData(id, s);
            return;
          }
          tail = s.slice(cut);
          const ready = s.slice(0, cut);
          if (ready) this.onData(id, ready);
        },
        flush: () => {
          if (tail) this.onData(id, tail);
          tail = "";
        },
      };
    };
    const out = makeStreamForward();
    const err = makeStreamForward();
    const session: Session = {
      id,
      child,
      flushTails: () => {
        out.flush();
        err.flush();
      },
    };
    this.byId.set(id, session);
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    child.on("exit", (code) => {
      session.flushTails();
      this.byId.delete(id);
      this.onExit(id, code);
    });
    child.on("error", () => {
      this.byId.delete(id);
      this.onExit(id, 1);
    });
    return { id, shell: shellName };
  }

  write(id: string, data: string): void {
    this.byId.get(id)?.child.stdin?.write(data);
  }

  kill(id: string): void {
    const s = this.byId.get(id);
    if (!s) return;
    this.byId.delete(id);
    this.killTree(s.child);
  }

  killAll(): void {
    for (const s of this.byId.values()) this.killTree(s.child);
    this.byId.clear();
  }

  private killTree(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], () => undefined);
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
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
