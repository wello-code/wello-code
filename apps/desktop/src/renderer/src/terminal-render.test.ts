import { describe, expect, it } from "vitest";
import { parsePromptLine, TermBuffer } from "./terminal-render";

const textLines = (b: TermBuffer): string[] =>
  b.spans().map((line) => line.map((s) => s.text).join(""));

describe("TermBuffer (custom terminal screen model)", () => {
  it("renders a plain cmd banner with CRLF line breaks", () => {
    const b = new TermBuffer();
    b.write("Microsoft Windows [Version 10.0]\r\n(c) Microsoft Corporation.\r\n\r\nC:\\dev>");
    expect(textLines(b)).toEqual([
      "Microsoft Windows [Version 10.0]",
      "(c) Microsoft Corporation.",
      "",
      "C:\\dev>",
    ]);
  });

  it("\\r overwrites the current line (progress bars)", () => {
    const b = new TermBuffer();
    b.write("progress 10%\rprogress 50%\rdone!");
    expect(textLines(b)).toEqual(["done!ess 50%"]);
    // …and erase-to-end cleans the leftovers, the way real progress bars do.
    b.write("\rdone!\x1b[K");
    expect(textLines(b)).toEqual(["done!"]);
  });

  it("applies SGR colours and resets, grouping spans by style", () => {
    const b = new TermBuffer();
    b.write("\x1b[31mred\x1b[0m plain \x1b[1;32mbold-green\x1b[m tail");
    const [line] = b.spans();
    expect(line!.map((s) => ({ t: s.text, fg: s.style?.fg ?? null, bold: s.style?.bold ?? false }))).toEqual([
      { t: "red", fg: "a1", bold: false },
      { t: " plain ", fg: null, bold: false },
      { t: "bold-green", fg: "a2", bold: true },
      { t: " tail", fg: null, bold: false },
    ]);
  });

  it("supports bright (90–97), 256-colour and truecolor SGR", () => {
    const b = new TermBuffer();
    b.write("\x1b[92mok\x1b[0m \x1b[38;5;196mred256\x1b[0m \x1b[38;2;1;2;3mtrue\x1b[0m");
    const [line] = b.spans();
    expect(line!.filter((s) => s.style).map((s) => s.style!.fg)).toEqual(["a10", "#ff0000", "#010203"]);
  });

  it("survives an escape sequence split across chunks", () => {
    const b = new TermBuffer();
    b.write("A\x1b[3");
    b.write("1mB\x1b");
    b.write("[0mC");
    const [line] = b.spans();
    expect(line!.map((s) => [s.text, s.style?.fg ?? null])).toEqual([
      ["A", null],
      ["B", "a1"],
      ["C", null],
    ]);
  });

  it("ESC[2J (cls) and form feed are SOFT clears: the transcript survives", () => {
    const b = new TermBuffer();
    b.write("old output\r\nmore\r\n");
    b.write("\x1b[2J\x1b[H");
    b.write("fresh>");
    // Scrollback intact, new screen starts on its own line.
    expect(textLines(b)).toEqual(["old output", "more", "fresh>"]);
    expect(b.text()).toContain("old output");
    // A ^L page separator inside `git diff`/`type`d content must NOT wipe history.
    b.write("\r\n+\x0c\r\n+section two\r\n");
    expect(b.text()).toContain("old output");
    expect(b.text()).toContain("+section two");
  });

  it("hard clear() wipes everything, including a dangling carry", () => {
    const b = new TermBuffer();
    b.write("secret\x1b[3");
    b.clear();
    b.write("[after]");
    expect(b.text()).toBe("[after]");
  });

  it("ESC[H addresses the screen (after the last clear), never deep scrollback", () => {
    const b = new TermBuffer();
    b.write("history line one is fairly long here\r\nline-two also long\r\nline-three\r\n");
    b.write("\x1b[2J"); // new screen
    b.write("frame one\r\nsecond row\r\n");
    // The classic redraw idiom: home + erase-below, then repaint.
    b.write("\x1b[H\x1b[J");
    b.write("FRESH\r\nOUT\r\n");
    const lines = textLines(b);
    // Old history untouched; the screen region shows only the new frame.
    expect(lines.slice(0, 3)).toEqual([
      "history line one is fairly long here",
      "line-two also long",
      "line-three",
    ]);
    expect(lines).toContain("FRESH");
    expect(lines).toContain("OUT");
    expect(lines.join("\n")).not.toContain("FRESHone");
  });

  it("ESC[0J erases from the cursor to the end of the screen", () => {
    const b = new TermBuffer();
    b.write("keep\r\nkill-tail\r\ngone entirely");
    b.write("\r\x1b[1A"); // unknown CSI (cursor up) is ignored — position stays
    const before = textLines(b).length;
    expect(before).toBe(3);
    // Move to col 4 of the current (last) line and erase below.
    b.write("\r\x1b[5G\x1b[0J");
    expect(textLines(b)[2]).toBe("gone");
  });

  it("oversized CSI/OSC junk is swallowed whole — no tail leaks into the output", () => {
    const b = new TermBuffer();
    b.write(`before\x1b[${"9".repeat(600)}m after`);
    expect(b.text()).toBe("before after");
    const c = new TermBuffer();
    c.write(`x\x1b]0;${"t".repeat(6000)}\x07visible`);
    expect(c.text()).toBe("xvisible");
    // …even when the junk spans several chunks.
    const d = new TermBuffer();
    d.write(`a\x1b[${"1".repeat(600)}`);
    d.write(`${"1".repeat(300)}m b`);
    expect(d.text()).toBe("a b");
  });

  it("a 100-byte parameter list is still a VALID sequence (cap tests the final byte first)", () => {
    const b = new TermBuffer();
    b.write(`\x1b[${"38;5;196;".repeat(11)}1mX\x1b[0m`);
    const [line] = b.spans();
    expect(line![0]!.style?.bold).toBe(true);
    expect(line![0]!.style?.fg).toBe("#ff0000");
  });

  it("parses ITU colon-form SGR: 38:5:N, 38:2::R:G:B and 4:3", () => {
    const b = new TermBuffer();
    b.write("\x1b[1;38:5:196;4mA\x1b[0m \x1b[38:2::0:255:0mB\x1b[0m \x1b[4:3mC\x1b[4:0mD");
    const [line] = b.spans();
    const styled = line!.filter((s) => s.style);
    expect(styled[0]!.style).toMatchObject({ bold: true, fg: "#ff0000", underline: true });
    expect(styled[1]!.style?.fg).toBe("#00ff00");
    expect(styled[2]!.style?.underline).toBe(true);
    expect(line![line!.length - 1]!.text).toContain("D");
    expect(line![line!.length - 1]!.style).toBeNull();
  });

  it("flushCarry() drops a dangling half-escape before an out-of-band note", () => {
    const b = new TermBuffer();
    b.write("output\x1b[3"); // split escape at the end of the stream
    b.flushCarry();
    b.write("\r\n\x1b[2m[сессия завершена]\x1b[0m\r\n");
    expect(b.text()).toBe("output\n[сессия завершена]");
  });

  it("firstLineIndex advances as the scrollback trims (stable list keys)", () => {
    const b = new TermBuffer();
    expect(b.firstLineIndex).toBe(0);
    for (let i = 0; i < 2500; i++) b.write(`l${i}\n`);
    expect(b.firstLineIndex).toBeGreaterThan(0);
    // 2500 written lines + the empty tail line after the final \n.
    expect(b.firstLineIndex + textLines(b).length).toBe(2501);
  });

  it("strips OSC title sequences (BEL and ESC\\\\ terminated), even split", () => {
    const b = new TermBuffer();
    b.write("\x1b]0;win");
    b.write("dow title\x07visible");
    b.write("\x1b]2;x\x1b");
    b.write("\\!");
    expect(textLines(b)).toEqual(["visible!"]);
  });

  it("expands tabs to 8-column stops and honours cursor-forward", () => {
    const b = new TermBuffer();
    b.write("ab\tX\r\n\x1b[4Cy");
    expect(textLines(b)).toEqual(["ab      X", "    y"]);
  });

  it("caps the scrollback and keeps writing at the tail", () => {
    const b = new TermBuffer();
    for (let i = 0; i < 2500; i++) b.write(`line ${i}\n`);
    b.write("tail");
    const lines = textLines(b);
    expect(lines.length).toBeLessThanOrEqual(2001);
    expect(lines[lines.length - 1]).toBe("tail");
    expect(lines[0]).not.toBe("line 0");
  });

  it("text() gives the plain scrollback for copying", () => {
    const b = new TermBuffer();
    b.write("\x1b[33mwarn\x1b[0m: thing\r\nnext\r\n");
    expect(b.text()).toBe("warn: thing\nnext");
  });

  it("bumps version on every visible write and on clear", () => {
    const b = new TermBuffer();
    const v0 = b.version;
    b.write("x");
    expect(b.version).toBeGreaterThan(v0);
    const v1 = b.version;
    b.clear();
    expect(b.version).toBeGreaterThan(v1);
  });

  it("keeps span identity for untouched lines between reads (memo-friendly)", () => {
    const b = new TermBuffer();
    b.write("first\r\nsecond");
    const a = b.spans();
    b.write("!");
    const c = b.spans();
    expect(c[0]).toBe(a[0]); // line 0 untouched → same reference
    expect(c[1]).not.toBe(a[1]);
  });
});

describe("lastLineText", () => {
  it("returns the last line's plain text without building spans", () => {
    const b = new TermBuffer();
    b.write("one\r\ntwo\r\n\x1b[32mC:\\proj>\x1b[0m");
    expect(b.lastLineText()).toBe("C:\\proj>");
  });
});

describe("parsePromptLine", () => {
  it("recognises cmd prompts and extracts the cwd", () => {
    expect(parsePromptLine("C:\\Users\\adm>")).toEqual({ cwd: "C:\\Users\\adm" });
    expect(parsePromptLine("C:\\> ")).toEqual({ cwd: "C:\\" });
  });

  it("recognises PowerShell prompts", () => {
    expect(parsePromptLine("PS C:\\proj\\app>")).toEqual({ cwd: "C:\\proj\\app" });
  });

  it("recognises bash-ish prompts without a cwd", () => {
    expect(parsePromptLine("user@host:~$")).toEqual({ cwd: null });
  });

  it("does NOT treat command echo or plain output as a prompt", () => {
    expect(parsePromptLine("C:\\proj>npm run dev")).toBeNull();
    expect(parsePromptLine("Compiled successfully")).toBeNull();
    expect(parsePromptLine("")).toBeNull();
  });
});
