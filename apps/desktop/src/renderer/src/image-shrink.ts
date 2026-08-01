/**
 * Attached screenshots are shrunk to what the model actually looks at.
 *
 * The report behind this: "по 2 картинки 15-20 минут может висеть". An attached
 * image is not sent once — it is part of the conversation, so every later turn
 * carries it again. A 4K screenshot is a megabyte or several; two of them on a
 * home uplink is minutes per turn, every turn.
 *
 * The API resizes anything longer than 1568 px on its long side before the model
 * sees it, so those extra pixels are uploaded, waited on, and thrown away. We do
 * the same resize locally and re-encode as WebP, which the API accepts and which
 * is what screenshots compress into. Measured here on real screenshots of a text
 * page (Electron 33 / Chromium 130):
 *
 *   3806x1884  1117 KB  ->  1568x776:  webp 93 KB (12x), jpeg 153 KB, png 410 KB
 *   1903x942    452 KB  ->  1568x776:  webp 153 KB (3x), jpeg 220 KB, png 564 KB
 *
 * Note the PNG column: re-encoding a screenshot as PNG after a resize makes it
 * BIGGER (crisp 1-pixel text compresses better than the anti-aliased result), so
 * the copy is only ever kept when it really is smaller than the original.
 */

/** The API's own ceiling: past this it resizes server-side anyway. */
export const MAX_IMAGE_EDGE = 1568;
/** Below this a re-encode at the same size is not worth the seconds it costs. */
export const RECODE_MIN_BYTES = 512 * 1024;
/** Screenshots and UI: high quality, still a fraction of a lossless encode. */
const QUALITY = 0.92;

export interface Size {
  width: number;
  height: number;
}

export interface ShrinkPlan {
  /** Draw size — the original size when only the encoding changes. */
  size: Size;
  type: string;
  quality: number;
}

/**
 * What to do with a picture of these dimensions, or null to leave it alone.
 * Never upscales, never touches an animated GIF (decoding one gives a single
 * frame, which would quietly throw the animation away).
 */
export function planShrink(sourceType: string, bytes: number, width: number, height: number): ShrinkPlan | null {
  if (sourceType === "image/gif") return null;
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0 || !Number.isFinite(bytes)) return null;
  if (longest > MAX_IMAGE_EDGE) {
    const scale = MAX_IMAGE_EDGE / longest;
    return {
      size: {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
      },
      type: "image/webp",
      quality: QUALITY,
    };
  }
  // Already small enough to send as it is — unless it is a heavy file, where
  // just re-encoding is worth several megabytes over a conversation.
  if (bytes >= RECODE_MIN_BYTES && sourceType !== "image/webp") {
    return { size: { width, height }, type: "image/webp", quality: QUALITY };
  }
  return null;
}

/**
 * A smaller copy of `blob`, or null when there is nothing to gain (already small,
 * an animation, an undecodable file, or a copy that came out no smaller). The
 * caller then attaches the original, exactly as before.
 */
export async function shrinkImage(blob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return null;
  let bitmap: ImageBitmap | null = null;
  try {
    if (blob.type === "image/gif") return null; // cheap exit before decoding
    bitmap = await createImageBitmap(blob);
    const plan = planShrink(blob.type || "image/png", blob.size, bitmap.width, bitmap.height);
    if (!plan) return null;
    const canvas = new OffscreenCanvas(plan.size.width, plan.size.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, plan.size.width, plan.size.height);
    const out = await canvas.convertToBlob({ type: plan.type, quality: plan.quality });
    return out.size > 0 && out.size < blob.size ? out : null;
  } catch {
    return null; // an exotic encoder, a decode failure — attach the original
  } finally {
    bitmap?.close();
  }
}
