import { deflateSync } from "node:zlib";
import type { ElectronApplication, Page } from "@playwright/test";

/**
 * Close the app even when a run is still in flight: the close guard holds the
 * window and shows the «Идёт генерация» dialog — confirm «Прервать и выйти» to
 * finish. A clean idle close never shows the dialog and the click times out
 * silently. (The button was «Завершить и выйти» before the 3-way close dialog;
 * it is «Прервать и выйти» now.)
 */
export async function closeApp(app: ElectronApplication): Promise<void> {
  const page = app.windows()[0];
  const closing = app.close();
  if (page) {
    await page
      .getByRole("button", { name: "Прервать и выйти" })
      .click({ timeout: 4_000 })
      .catch(() => {});
  }
  await closing;
}

/**
 * A valid single-colour PNG, built here rather than pasted in as base64.
 *
 * Written after a base64 literal in a spec turned out to be corrupt — the model
 * dutifully reported a CRC mismatch in the IDAT chunk and refused to name the
 * colour, and for a while that looked like a bug in the app. A picture a vision
 * test depends on has to be provably intact, so it is generated: the bytes come
 * out the same every run and nothing in between can mangle them.
 */
export function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const stride = 1 + size * 3; // one filter byte per scanline, then RGB triples
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = rgb[0];
      raw[row + 2 + x * 3] = rgb[1];
      raw[row + 3 + x * 3] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Open the model picker and report whether it offers a model, closing it again
 * when it does not.
 *
 * Written when part of the catalog was temporarily withdrawn from the picker
 * (2026-08-08): the specs for those models are worth keeping for when they come
 * back, so they ask instead of failing on a missing option.
 */
export async function modelOffered(page: Page, name: RegExp): Promise<boolean> {
  await page
    .getByRole("button", { name: /Sonnet 5|Opus|Fable|GPT/ })
    .first()
    .click();
  const offered = (await page.getByRole("option", { name }).count()) > 0;
  if (!offered) await page.keyboard.press("Escape");
  return offered;
}
