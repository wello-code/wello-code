/**
 * Composer attachment limits — mirrors Claude's (claude.ai / Claude API, 2026-07):
 * up to 20 attachments per message, images up to 10 MB each (the API's per-image
 * cap), files up to 500 MB each. Folders and text pastes have no size to check.
 * When something is rejected, the UI reminds the user they can simply drop the
 * files into the project folder — the agent reads them from disk anyway.
 */

export const MAX_ATTACHMENTS = 20;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 500 * 1024 * 1024;

export type AttachmentKind = "file" | "folder" | "image" | "paste";

export interface AdmitCandidate {
  kind: AttachmentKind;
  /** Bytes on disk; null/undefined = unknown (folders, pastes) — no size check. */
  size?: number | null;
}

export interface AdmitRejects {
  /** Over the 20-per-message cap. */
  count: number;
  /** Images over 10 MB. */
  imageSize: number;
  /** Files over 500 MB. */
  fileSize: number;
}

export interface AdmitResult {
  /** Indexes (into the candidates array) that made it in, in order. */
  accepted: number[];
  rejects: AdmitRejects;
}

/** Which candidates fit under Claude's limits, given how many chips are already attached. */
export function admitAttachments(currentCount: number, candidates: AdmitCandidate[]): AdmitResult {
  const rejects: AdmitRejects = { count: 0, imageSize: 0, fileSize: 0 };
  const accepted: number[] = [];
  let used = Math.max(0, currentCount);
  candidates.forEach((c, index) => {
    if (c.kind === "image" && c.size != null && c.size > MAX_IMAGE_BYTES) {
      rejects.imageSize += 1;
      return;
    }
    if (c.kind === "file" && c.size != null && c.size > MAX_FILE_BYTES) {
      rejects.fileSize += 1;
      return;
    }
    if (used >= MAX_ATTACHMENTS) {
      rejects.count += 1;
      return;
    }
    used += 1;
    accepted.push(index);
  });
  return { accepted, rejects };
}

/** Human notice for the composer when limits kicked in. Null when nothing was rejected. */
export function limitNotice(rejects: AdmitRejects): string | null {
  const parts: string[] = [];
  if (rejects.count > 0) {
    parts.push(`Как и в Claude, к сообщению можно приложить не больше ${MAX_ATTACHMENTS} вложений.`);
  }
  if (rejects.imageSize > 0) {
    parts.push("Картинки больше 10 МБ не прикрепляются.");
  }
  if (rejects.fileSize > 0) {
    parts.push("Файлы больше 500 МБ не прикрепляются.");
  }
  if (parts.length === 0) return null;
  parts.push("Просто положите нужные файлы в папку проекта — агент сам прочитает их с диска.");
  return parts.join(" ");
}
