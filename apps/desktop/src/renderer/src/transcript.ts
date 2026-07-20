import type { TimelineItem } from "./agent-state";

/**
 * Render a chat's timeline as Markdown for export / handoff. Pure — no DOM, no
 * IPC. Tool steps collapse to a single bullet line (the answer text is what a
 * reader wants); plan items become a checklist; notes are quoted.
 */
export function chatToMarkdown(title: string, items: TimelineItem[]): string {
  const lines: string[] = [`# ${title || "Диалог Wello Code"}`, ""];
  let pendingTools: string[] = [];
  const flushTools = (): void => {
    if (pendingTools.length === 0) return;
    lines.push("<details><summary>Действия агента</summary>", "");
    for (const t of pendingTools) lines.push(`- ${t}`);
    lines.push("", "</details>", "");
    pendingTools = [];
  };
  for (const item of items) {
    if (item.kind === "tool") {
      pendingTools.push(item.summary);
      continue;
    }
    flushTools();
    switch (item.kind) {
      case "user": {
        lines.push("## 🧑 Вы", "");
        if (item.attachments && item.attachments.length > 0) {
          lines.push(`*Вложения: ${item.attachments.map((a) => a.label).join(", ")}*`, "");
        }
        lines.push(item.text.trim() || "*(без текста)*", "");
        break;
      }
      case "message":
        lines.push("## 🤖 Агент", "", item.text.trim() || "*(пусто)*", "");
        break;
      case "plan":
        lines.push("### План", "");
        for (const s of item.steps) lines.push(`- ${s.title}`);
        lines.push("");
        break;
      case "note":
        lines.push(`> ${item.text.replace(/\n/g, "\n> ")}`, "");
        break;
    }
  }
  flushTools();
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/**
 * A compact plain-text transcript of the last turns, for the model to compress
 * into a handoff note. Tool steps and notes are dropped — only the human/agent
 * exchange carries the thread's intent. Capped so a long chat doesn't blow the
 * prompt budget (keeps the most recent turns, which matter most for continuing).
 */
export function transcriptForHandoff(items: TimelineItem[], maxChars = 12_000): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.kind === "user") parts.push(`Пользователь: ${item.text.trim()}`);
    else if (item.kind === "message" && item.text.trim()) parts.push(`Агент: ${item.text.trim()}`);
  }
  let text = parts.join("\n\n");
  if (text.length > maxChars) text = "…\n\n" + text.slice(text.length - maxChars);
  return text;
}
