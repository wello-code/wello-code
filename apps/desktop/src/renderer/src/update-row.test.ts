import { describe, expect, it } from "vitest";
import { updateRow } from "./Settings";

/**
 * The update row is the whole UI surface of auto-update, so its two invariants are
 * worth pinning: in-flight states offer no button (you cannot cancel or double-fire
 * a check/download), and every actionable state names the action it will take.
 */
describe("updateRow", () => {
  it("offers no action while something is in flight", () => {
    expect(updateRow({ state: "checking" }).act).toBeUndefined();
    expect(updateRow({ state: "downloading", percent: 42 }).act).toBeUndefined();
  });

  it("shows download progress as a whole percentage", () => {
    expect(updateRow({ state: "downloading", percent: 42 }).desc).toBe("Загрузка… 42%");
  });

  it("names the version when one is available, and offers to download it", () => {
    const row = updateRow({ state: "available", version: "0.2.0" });
    expect(row.desc).toContain("0.2.0");
    expect(row.act).toBe("download");
  });

  it("offers the restart only once the download is ready", () => {
    const row = updateRow({ state: "ready", version: "0.2.0" });
    expect(row.act).toBe("install");
    expect(row.label).toBe("Перезапустить и обновить");
  });

  it("surfaces the error text itself and lets the user retry", () => {
    const row = updateRow({ state: "error", message: "Не удалось проверить обновления" });
    expect(row.desc).toBe("Не удалось проверить обновления");
    expect(row.act).toBe("check");
  });

  it("explains itself in a dev run instead of offering a dead button", () => {
    const row = updateRow({ state: "unsupported" });
    expect(row.act).toBeUndefined();
    expect(row.desc).toContain("установленном");
  });

  it("every actionable state carries a label", () => {
    const states = [
      { state: "idle" } as const,
      { state: "none" } as const,
      { state: "available", version: "1.0.0" } as const,
      { state: "ready", version: "1.0.0" } as const,
      { state: "error", message: "x" } as const,
    ];
    for (const s of states) {
      const row = updateRow(s);
      expect(row.act, `${s.state} should act`).toBeDefined();
      expect(row.label, `${s.state} should be labelled`).toBeTruthy();
    }
  });
});
