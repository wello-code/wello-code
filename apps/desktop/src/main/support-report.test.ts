import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSupportReport, readTail, reportFilePath, scrubSecrets } from "./support-report";

const cleanups: string[] = [];
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true });
});

describe("scrubSecrets", () => {
  it("masks anything token-shaped before the file leaves the machine", () => {
    const raw = [
      "key wlo_live_0123456789abcdef0123456789abcdef01234567 used",
      "Authorization: Bearer abcdef0123456789abcdef0123456789",
      "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 pushed",
      "pat github_pat_11ABCDEFGHIJKLMNOPQRST_abcdefghijklmnop",
    ].join("\n");
    const out = scrubSecrets(raw);
    expect(out).not.toMatch(/wlo_live_[a-f0-9]{8}/);
    expect(out).not.toContain("ghp_ABCDEFGH");
    expect(out).not.toContain("github_pat_11");
    expect(out).not.toContain("Bearer abcdef");
    expect(out).toContain("[скрыто]");
  });

  it("leaves ordinary text and short ids alone", () => {
    const raw = "run r-42 finished, файл C:/proj/index.js, ghp это не токен";
    expect(scrubSecrets(raw)).toBe(raw);
  });
});

describe("buildSupportReport", () => {
  it("assembles versions, load and the log tail into one scrubbed file", () => {
    const text = buildSupportReport({
      appVersion: "0.1.14",
      electronVersion: "31.0.0",
      platform: "win32",
      arch: "x64",
      osVersion: "10.0.26200",
      perfText: "Tab 300 MB",
      logTail: "engine: API Error 503\nkey wlo_live_0123456789abcdef0123456789abcdef01234567",
      now: new Date("2026-08-06T12:00:00Z"),
    });
    expect(text).toContain("Версия приложения: 0.1.14");
    expect(text).toContain("win32 x64 (10.0.26200)");
    expect(text).toContain("Tab 300 MB");
    expect(text).toContain("API Error 503");
    expect(text).not.toMatch(/wlo_live_[a-f0-9]{8}/);
  });

  it("says so honestly when the log is empty", () => {
    const text = buildSupportReport({
      appVersion: "0.1.14",
      electronVersion: "31",
      platform: "win32",
      arch: "x64",
      osVersion: "10",
      perfText: "x",
      logTail: "",
    });
    expect(text).toContain("(журнал пуст)");
  });
});

describe("readTail", () => {
  it("returns only the last bytes of a large file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wello-report-"));
    cleanups.push(dir);
    const file = join(dir, "big.log");
    await writeFile(file, "старьё\n".repeat(1000) + "СВЕЖАЯ СТРОКА");
    const tail = await readTail(file, 64);
    expect(tail).toContain("СВЕЖАЯ СТРОКА");
    expect(tail.length).toBeLessThanOrEqual(64);
  });

  it("an absent file reads as empty, not as an error", async () => {
    expect(await readTail("C:/definitely/not/here.log")).toBe("");
  });
});

describe("reportFilePath", () => {
  it("creates the reports folder and stamps the name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wello-report-"));
    cleanups.push(dir);
    const path = await reportFilePath(dir, new Date("2026-08-06T12:34:00Z"));
    expect(path).toContain("reports");
    expect(path).toMatch(/wello-report-2026-08-06-12-34\.txt$/);
  });
});
