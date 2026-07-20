import { describe, expect, it } from "vitest";
import {
  admitAttachments,
  limitNotice,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
} from "./attachments";

const MB = 1024 * 1024;

describe("admitAttachments (Claude-style limits)", () => {
  it("accepts everything under the limits", () => {
    const { accepted, rejects } = admitAttachments(0, [
      { kind: "file", size: 5 * MB },
      { kind: "image", size: 9 * MB },
      { kind: "folder" },
      { kind: "paste" },
    ]);
    expect(accepted).toEqual([0, 1, 2, 3]);
    expect(rejects).toEqual({ count: 0, imageSize: 0, fileSize: 0 });
  });

  it("caps a message at 20 attachments, counting the ones already there", () => {
    const { accepted, rejects } = admitAttachments(MAX_ATTACHMENTS - 1, [
      { kind: "file", size: 1 },
      { kind: "file", size: 1 },
    ]);
    expect(accepted).toEqual([0]);
    expect(rejects.count).toBe(1);
  });

  it("rejects images over 10 MB without eating a slot", () => {
    const { accepted, rejects } = admitAttachments(MAX_ATTACHMENTS - 1, [
      { kind: "image", size: MAX_IMAGE_BYTES + 1 },
      { kind: "file", size: 1 },
    ]);
    // The oversized image is rejected on size; the file still fits in the last slot.
    expect(accepted).toEqual([1]);
    expect(rejects).toEqual({ count: 0, imageSize: 1, fileSize: 0 });
  });

  it("rejects files over 500 MB and images exactly at the boundary pass", () => {
    const { accepted, rejects } = admitAttachments(0, [
      { kind: "file", size: MAX_FILE_BYTES + 1 },
      { kind: "image", size: MAX_IMAGE_BYTES },
    ]);
    expect(accepted).toEqual([1]);
    expect(rejects.fileSize).toBe(1);
  });

  it("does not size-check folders and pastes", () => {
    const { accepted } = admitAttachments(0, [{ kind: "folder" }, { kind: "paste" }]);
    expect(accepted).toEqual([0, 1]);
  });
});

describe("limitNotice", () => {
  it("is silent when nothing was rejected", () => {
    expect(limitNotice({ count: 0, imageSize: 0, fileSize: 0 })).toBeNull();
  });

  it("mentions the cap and the workspace-folder escape hatch", () => {
    const note = limitNotice({ count: 2, imageSize: 0, fileSize: 0 })!;
    expect(note).toContain("20");
    expect(note).toContain("папку проекта");
  });

  it("mentions image and file size limits", () => {
    const note = limitNotice({ count: 0, imageSize: 1, fileSize: 1 })!;
    expect(note).toContain("10 МБ");
    expect(note).toContain("500 МБ");
  });
});
