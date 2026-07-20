/**
 * A tiny terminal screen model for the CUSTOM terminal view (no xterm): parses
 * the shell's byte stream (ANSI SGR colours, \r progress rewrites, erase-line,
 * clear-screen, OSC titles) into styled lines we render as plain DOM with the
 * app's own fonts/tokens — so the panel looks native to the IDE instead of an
 * embedded black box with its own metrics.
 *
 * Scope is deliberately the piped-shell reality: git/npm colours and progress
 * bars, cls, prompts. Full-screen cursor addressing (vim/htop) is NOT supported
 * — it never worked over pipes anyway. Escape sequences may be split across
 * stdout chunks, so the parser keeps a partial-sequence carry between write()s.
 *
 * Clear semantics (adversarial-review driven): FF and ESC[2J are a SOFT clear —
 * the scrollback (and the Copy button's transcript) survives; only the "screen"
 * restarts at a fresh line, tracked by `screenTop`. ESC[H/J address that screen
 * region, never the deep scrollback. The HARD wipe is reserved for the user's
 * own Clear action (clear()).
 */

export interface TermStyle {
  /** 'a0'..'a15' = ANSI palette slot (rendered via CSS vars), '#rrggbb' = exact. */
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

export interface TermSpan {
  text: string;
  /** null = completely unstyled (the common fast path). */
  style: TermStyle | null;
}

interface Cell {
  ch: string;
  style: TermStyle | null;
}

const DEFAULT_STYLE: TermStyle = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
};

/** Max retained lines — old scrollback beyond this is dropped. */
const MAX_LINES = 2000;
/** A hard per-line cap so a pathological single-line stream can't eat memory. */
const MAX_COLS = 4000;
/** Past this many scanned bytes a CSI/OSC is junk — swallow it to its terminator. */
const MAX_CSI_SCAN = 512;
const MAX_OSC_SCAN = 4096;

function styleIsDefault(s: TermStyle): boolean {
  return !s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline;
}

function sameStyle(a: TermStyle | null, b: TermStyle | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}

/** xterm-256 palette: 16 named slots, a 6×6×6 colour cube, a 24-step gray ramp. */
function color256(n: number): string | null {
  if (n < 0) return null;
  if (n < 16) return `a${n}`;
  if (n < 232) {
    const idx = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(idx / 36) % 6]!;
    const g = steps[Math.floor(idx / 6) % 6]!;
    const b = steps[idx % 6]!;
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  }
  if (n < 256) {
    const v = 8 + (n - 232) * 10;
    return `#${((1 << 24) | (v << 16) | (v << 8) | v).toString(16).slice(1)}`;
  }
  return null;
}

function rgbHex(r: number, g: number, b: number): string {
  const cl = (x: number): number => Math.min(255, Math.max(0, x | 0));
  return `#${((1 << 24) | (cl(r) << 16) | (cl(g) << 8) | cl(b)).toString(16).slice(1)}`;
}

export class TermBuffer {
  /** Bumped on every write()/clear() — the view may key refreshes on it. */
  version = 0;

  private lines: Cell[][] = [[]];
  private lineRevs: number[] = [0];
  private spanCache: (TermSpan[] | null)[] = [null];
  private cachedRevs: number[] = [-1];
  /** Global index of lines[0] — grows as the scrollback trims. Stable React keys. */
  private base = 0;
  /** Index (within `lines`) where the current "screen" starts (soft clears). */
  private screenTop = 0;
  private row = 0;
  private col = 0;
  private style: TermStyle = DEFAULT_STYLE;
  /** Tail of an escape sequence cut off at a chunk boundary. */
  private carry = "";
  /** Swallow mode for an oversized CSI/OSC: drop input until its terminator. */
  private discard: "csi" | "osc" | null = null;

  /** Global index of the first retained line (for stable list keys). */
  get firstLineIndex(): number {
    return this.base;
  }

  write(chunk: string): void {
    const data = this.carry + chunk;
    this.carry = "";
    let i = 0;
    const len = data.length;

    while (i < len) {
      if (this.discard) {
        i = this.drainDiscard(data, i);
        continue;
      }
      const ch = data[i]!;
      if (ch === "\x1b") {
        const consumed = this.parseEscape(data, i);
        if (consumed === 0) {
          // Incomplete sequence at the end of the chunk — keep it for the next one.
          this.carry = data.slice(i);
          break;
        }
        i += consumed;
        continue;
      }
      if (ch === "\n") {
        this.newline();
        i++;
        continue;
      }
      if (ch === "\r") {
        this.col = 0;
        i++;
        continue;
      }
      if (ch === "\b") {
        if (this.col > 0) this.col--;
        i++;
        continue;
      }
      if (ch === "\t") {
        this.col = Math.min(MAX_COLS, (Math.floor(this.col / 8) + 1) * 8);
        i++;
        continue;
      }
      if (ch === "\x0c") {
        // Form feed: piped `cls` emits it — but so do ^L page separators inside
        // `git diff`/`type`d files. Soft clear: the transcript must survive.
        this.softClear();
        i++;
        continue;
      }
      if (ch === "\x07" || ch < " ") {
        i++; // bell + any other C0 control we don't model
        continue;
      }
      // A run of printable characters — write them in one go.
      let j = i;
      while (j < len) {
        const c = data[j]!;
        if (c === "\x1b" || c === "\n" || c === "\r" || c === "\b" || c === "\t" || c < " ") break;
        j++;
      }
      this.print(data.slice(i, j));
      i = j;
    }
    this.version++;
  }

  /** HARD wipe — the user's own Clear action. Escapes mid-flight are dropped too. */
  clear(): void {
    this.base += this.lines.length;
    this.lines = [[]];
    this.lineRevs = [0];
    this.spanCache = [null];
    this.cachedRevs = [-1];
    this.screenTop = 0;
    this.row = 0;
    this.col = 0;
    this.carry = "";
    this.discard = null;
    this.version++;
  }

  /**
   * Drops a dangling partial escape before an out-of-band write (the session-exit
   * banner) so it can't be glued onto the carried sequence and garbled.
   */
  flushCarry(): void {
    this.carry = "";
    this.discard = null;
  }

  /** Styled spans per line; span arrays are referentially stable while a line is unchanged. */
  spans(): TermSpan[][] {
    const out: TermSpan[][] = new Array(this.lines.length);
    for (let r = 0; r < this.lines.length; r++) {
      if (this.cachedRevs[r] === this.lineRevs[r] && this.spanCache[r]) {
        out[r] = this.spanCache[r]!;
        continue;
      }
      const cells = this.lines[r]!;
      const spans: TermSpan[] = [];
      let text = "";
      let cur: TermStyle | null = null;
      for (const cell of cells) {
        if (sameStyle(cell.style, cur)) {
          text += cell.ch;
        } else {
          if (text) spans.push({ text, style: cur });
          cur = cell.style;
          text = cell.ch;
        }
      }
      if (text) spans.push({ text, style: cur });
      this.spanCache[r] = spans;
      this.cachedRevs[r] = this.lineRevs[r]!;
      out[r] = spans;
    }
    return out;
  }

  /** Plain text of the whole scrollback (for the copy button). */
  text(): string {
    return this.lines
      .map((cells) => cells.map((c) => c.ch).join(""))
      .join("\n")
      .replace(/\n+$/, "");
  }

  /** Plain text of the LAST line only — cheap enough to run per chunk (the
   *  prompt heuristics for tab titles read it; no span building involved). */
  lastLineText(): string {
    const cells = this.lines[this.lines.length - 1] ?? [];
    return cells.map((c) => c.ch).join("");
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private touch(r: number): void {
    this.lineRevs[r] = (this.lineRevs[r] ?? 0) + 1;
  }

  /** New screen at the tail; scrollback above stays intact (FF / ESC[2J). */
  private softClear(): void {
    const last = this.lines[this.lines.length - 1]!;
    if (last.length > 0) {
      this.row = this.lines.length - 1;
      this.newline();
    } else {
      this.row = this.lines.length - 1;
    }
    this.col = 0;
    this.screenTop = this.row;
  }

  private newline(): void {
    this.row++;
    this.col = 0;
    if (this.row >= this.lines.length) {
      this.lines.push([]);
      this.lineRevs.push(0);
      this.spanCache.push(null);
      this.cachedRevs.push(-1);
    }
    if (this.lines.length > MAX_LINES) {
      const drop = this.lines.length - MAX_LINES;
      this.lines.splice(0, drop);
      this.lineRevs.splice(0, drop);
      this.spanCache.splice(0, drop);
      this.cachedRevs.splice(0, drop);
      this.base += drop;
      this.row = Math.max(0, this.row - drop);
      this.screenTop = Math.max(0, this.screenTop - drop);
    }
  }

  private print(run: string): void {
    if (this.col >= MAX_COLS) return;
    const line = this.lines[this.row]!;
    const style = styleIsDefault(this.style) ? null : this.style;
    // Pad with blanks when the cursor sits past the end (cursor-forward moves).
    while (line.length < this.col) line.push({ ch: " ", style: null });
    for (const ch of run) {
      if (this.col >= MAX_COLS) break;
      line[this.col] = { ch, style };
      this.col++;
    }
    this.touch(this.row);
  }

  /** Swallows an oversized CSI/OSC until its terminator; returns the new index. */
  private drainDiscard(data: string, i: number): number {
    if (this.discard === "csi") {
      while (i < data.length) {
        const c = data.charCodeAt(i);
        i++;
        if (c >= 0x40 && c <= 0x7e) {
          this.discard = null;
          return i;
        }
      }
      return i; // still inside the junk sequence — keep discarding next chunk
    }
    // OSC: ends on BEL or ESC \
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === "\x07") {
        this.discard = null;
        return i + 1;
      }
      if (ch === "\x1b" && data[i + 1] === "\\") {
        this.discard = null;
        return i + 2;
      }
      i++;
    }
    return i;
  }

  /**
   * Parses one escape sequence at `data[i]` ('\x1b'). Returns consumed length,
   * or 0 when the sequence is incomplete (chunk boundary) and must be carried.
   */
  private parseEscape(data: string, i: number): number {
    if (i + 1 >= data.length) return 0;
    const kind = data[i + 1]!;

    if (kind === "[") {
      // CSI: ESC [ params… final-byte(0x40–0x7e). The final-byte test runs
      // BEFORE the size cap so a sequence ending exactly at the cap still parses.
      let j = i + 2;
      while (j < data.length) {
        const c = data.charCodeAt(j);
        if (c >= 0x40 && c <= 0x7e) {
          this.applyCsi(data.slice(i + 2, j), data[j]!);
          return j - i + 1;
        }
        if (j - i > MAX_CSI_SCAN) {
          // Junk/oversized — swallow the rest up to its terminator, render nothing.
          this.discard = "csi";
          return j - i;
        }
        j++;
      }
      return 0;
    }

    if (kind === "]") {
      // OSC: ESC ] … terminated by BEL or ESC \  (window titles etc. — strip)
      let j = i + 2;
      while (j < data.length) {
        if (data[j] === "\x07") return j - i + 1;
        if (data[j] === "\x1b") {
          if (j + 1 >= data.length) return 0;
          if (data[j + 1] === "\\") return j - i + 2;
        }
        if (j - i > MAX_OSC_SCAN) {
          this.discard = "osc";
          return j - i;
        }
        j++;
      }
      return 0;
    }

    if (kind === "(" || kind === ")") {
      // Charset designation: ESC ( X — three bytes.
      return i + 2 < data.length ? 3 : 0;
    }

    // Any other two-byte escape (ESC =, ESC >, ESC M, …) — skip both.
    return 2;
  }

  private applyCsi(params: string, final: string): void {
    if (final === "m") {
      this.applySgr(params);
      return;
    }
    const nums = params.split(";").map((p) => (p === "" ? 0 : Number.parseInt(p, 10) || 0));
    const n = nums[0] ?? 0;

    if (final === "K") {
      // Erase in line: 0 = cursor→end (default), 1 = start→cursor, 2 = whole line.
      const line = this.lines[this.row]!;
      if (n === 0) line.length = Math.min(line.length, this.col);
      else if (n === 1) {
        for (let c = 0; c < Math.min(this.col + 1, line.length); c++) line[c] = { ch: " ", style: null };
      } else if (n === 2) line.length = 0;
      this.touch(this.row);
      return;
    }
    if (final === "J") {
      // Erase in display, scoped to the SCREEN region (screenTop…end):
      // 0 = cursor→end, 1 = screenTop→cursor, 2/3 = whole screen (soft clear).
      if (n === 2 || n === 3) {
        this.softClear();
        return;
      }
      if (n === 0) {
        const line = this.lines[this.row]!;
        line.length = Math.min(line.length, this.col);
        this.touch(this.row);
        const below = this.lines.length - (this.row + 1);
        if (below > 0) {
          this.lines.splice(this.row + 1, below);
          this.lineRevs.splice(this.row + 1, below);
          this.spanCache.splice(this.row + 1, below);
          this.cachedRevs.splice(this.row + 1, below);
        }
        return;
      }
      if (n === 1) {
        for (let r = this.screenTop; r <= this.row && r < this.lines.length; r++) {
          if (r < this.row) this.lines[r] = [];
          else {
            const line = this.lines[r]!;
            for (let c = 0; c < Math.min(this.col + 1, line.length); c++) line[c] = { ch: " ", style: null };
          }
          this.touch(r);
        }
        return;
      }
      return;
    }
    if (final === "H" || final === "f") {
      // Cursor addressing is relative to the SCREEN (after the last clear), never
      // the deep scrollback — ESC[H ESC[J redraw loops must not chew old history.
      const wantRow = this.screenTop + Math.max((nums[0] ?? 1) - 1, 0);
      this.row = Math.min(Math.max(wantRow, this.screenTop), this.lines.length - 1);
      this.col = Math.min(Math.max((nums[1] ?? 1) - 1, 0), MAX_COLS);
      return;
    }
    if (final === "C") {
      this.col = Math.min(MAX_COLS, this.col + Math.max(n, 1));
      return;
    }
    if (final === "D") {
      this.col = Math.max(0, this.col - Math.max(n, 1));
      return;
    }
    if (final === "G") {
      this.col = Math.min(Math.max(n - 1, 0), MAX_COLS);
      return;
    }
    // Everything else (scroll regions, modes, cursor save/restore) — ignore.
  }

  private applySgr(params: string): void {
    // Both separators occur in the wild: classic `38;5;196` and ITU-style
    // `38:5:196` (with an optional colourspace slot in `38:2::R:G:B`).
    const parts = params === "" ? ["0"] : params.split(";");
    let s = { ...this.style };
    for (let k = 0; k < parts.length; k++) {
      const part = parts[k]!;
      if (part.includes(":")) {
        const sub = part.split(":").map((x) => (x === "" ? -1 : Number.parseInt(x, 10) || 0));
        const head = sub[0];
        if (head === 38 || head === 48) {
          let value: string | null = null;
          if (sub[1] === 5) value = color256(sub[2] ?? -1);
          else if (sub[1] === 2) {
            // 38:2:R:G:B or 38:2:<colourspace>:R:G:B — RGB are the last three.
            const tail = sub.slice(2).filter((x) => x >= 0);
            if (tail.length >= 3) {
              const [r, g, b] = tail.slice(-3) as [number, number, number];
              value = rgbHex(r, g, b);
            }
          }
          if (head === 38) s.fg = value;
          else s.bg = value;
        } else if (head === 4) {
          // 4:x underline styles — we render any non-zero as plain underline.
          s.underline = (sub[1] ?? 1) !== 0;
        }
        continue;
      }
      const p = part === "" ? 0 : Number.parseInt(part, 10) || 0;
      if (p === 0) s = { ...DEFAULT_STYLE };
      else if (p === 1) s.bold = true;
      else if (p === 2) s.dim = true;
      else if (p === 3) s.italic = true;
      else if (p === 4) s.underline = true;
      else if (p === 21 || p === 22) {
        s.bold = false;
        s.dim = false;
      } else if (p === 23) s.italic = false;
      else if (p === 24) s.underline = false;
      else if (p >= 30 && p <= 37) s.fg = `a${p - 30}`;
      else if (p === 39) s.fg = null;
      else if (p >= 40 && p <= 47) s.bg = `a${p - 40}`;
      else if (p === 49) s.bg = null;
      else if (p >= 90 && p <= 97) s.fg = `a${p - 90 + 8}`;
      else if (p >= 100 && p <= 107) s.bg = `a${p - 100 + 8}`;
      else if (p === 38 || p === 48) {
        // Extended colour, semicolon form: 38;5;N (256) or 38;2;R;G;B.
        const mode = Number.parseInt(parts[k + 1] ?? "", 10);
        let value: string | null = null;
        if (mode === 5) {
          value = color256(Number.parseInt(parts[k + 2] ?? "", 10));
          k += 2;
        } else if (mode === 2) {
          value = rgbHex(
            Number.parseInt(parts[k + 2] ?? "0", 10) || 0,
            Number.parseInt(parts[k + 3] ?? "0", 10) || 0,
            Number.parseInt(parts[k + 4] ?? "0", 10) || 0,
          );
          k += 4;
        } else {
          k += 1; // unknown submode — consume it and move on
        }
        if (p === 38) s.fg = value;
        else s.bg = value;
      }
    }
    this.style = styleIsDefault(s) ? DEFAULT_STYLE : s;
  }
}

/**
 * Resting-prompt heuristics for the terminal tab titles: when the shell prints
 * its prompt again, the foreground command is over (title falls back to the
 * shell name) and — for cmd/PowerShell — the prompt carries the current
 * directory. Returns null when the line does not look like a resting prompt.
 */
export function parsePromptLine(line: string): { cwd: string | null } | null {
  const t = line.trimEnd();
  let m = /^([A-Za-z]:[\\/][^<>|?*\n]*)>$/.exec(t); // cmd: C:\path>
  if (m) return { cwd: m[1]! };
  m = /^PS ([A-Za-z]:[\\/][^<>|?*\n]*)>$/.exec(t); // PowerShell: PS C:\path>
  if (m) return { cwd: m[1]! };
  // bash/zsh-ish: a short spaceless line ending in $ / % / # ("user@host:~$").
  if (t.length > 0 && t.length <= 160 && /^[^\s]{0,150}[$%#]$/.test(t)) return { cwd: null };
  return null;
}
