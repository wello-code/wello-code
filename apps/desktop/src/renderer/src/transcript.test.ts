import { describe, expect, it } from "vitest";
import { chatToMarkdown, transcriptForHandoff } from "./transcript";
import type { TimelineItem } from "./agent-state";

const items: TimelineItem[] = [
  { kind: "user", id: "u1", text: "Fix the login bug", attachments: [{ kind: "file", label: "auth.ts" }] },
  { kind: "tool", id: "t1", summary: "Read auth.ts", status: "succeeded", icon: "file", subagent: false },
  { kind: "tool", id: "t2", summary: "Edit auth.ts", status: "succeeded", icon: "edit", subagent: false },
  { kind: "message", id: "m1", text: "Fixed the null check in `verify()`.", done: true },
  { kind: "note", id: "n1", text: "Запуск отменён", tone: "cancelled" },
];

describe("chatToMarkdown", () => {
  it("renders roles, folds tool steps, keeps attachments and notes", () => {
    const md = chatToMarkdown("Login fix", items);
    expect(md).toContain("# Login fix");
    expect(md).toContain("## 🧑 Вы");
    expect(md).toContain("*Вложения: auth.ts*");
    expect(md).toContain("Fix the login bug");
    expect(md).toContain("<details><summary>Действия агента</summary>");
    expect(md).toContain("- Read auth.ts");
    expect(md).toContain("- Edit auth.ts");
    expect(md).toContain("## 🤖 Агент");
    expect(md).toContain("Fixed the null check");
    expect(md).toContain("> Запуск отменён");
    expect(md.endsWith("\n")).toBe(true);
    expect(md).not.toMatch(/\n{3,}/); // no triple blank lines
  });

  it("falls back to a default title", () => {
    expect(chatToMarkdown("", [])).toContain("# Диалог Wello Code");
  });
});

describe("transcriptForHandoff", () => {
  it("keeps only the human/agent exchange", () => {
    const t = transcriptForHandoff(items);
    expect(t).toContain("Пользователь: Fix the login bug");
    expect(t).toContain("Агент: Fixed the null check");
    expect(t).not.toContain("Read auth.ts");
    expect(t).not.toContain("Запуск отменён");
  });

  it("keeps the most recent tail when over the cap", () => {
    const many: TimelineItem[] = Array.from({ length: 50 }, (_, i) => ({
      kind: "user" as const,
      id: `u${i}`,
      text: `message number ${i} ${"x".repeat(500)}`,
    }));
    const t = transcriptForHandoff(many, 2000);
    expect(t.length).toBeLessThanOrEqual(2010);
    expect(t.startsWith("…")).toBe(true);
    expect(t).toContain("message number 49");
    expect(t).not.toContain("message number 0 ");
  });
});
