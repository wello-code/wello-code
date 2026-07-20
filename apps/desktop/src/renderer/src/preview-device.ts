/**
 * Pure device-frame math for the responsive preview. The framed page always lays
 * out at its true CSS width (so real breakpoints fire); we only visually scale it
 * to fit the pane with transform:scale, never upscaling past 1.
 */

export interface DevicePreset {
  id: "mobile" | "tablet" | "desktop";
  label: string;
  /** CSS width in px, or "fill" to use the pane's own width (desktop). */
  width: number | "fill";
}

export const DEVICE_PRESETS: DevicePreset[] = [
  { id: "mobile", label: "Телефон", width: 375 },
  { id: "tablet", label: "Планшет", width: 768 },
  { id: "desktop", label: "Десктоп", width: "fill" },
];

export const PREVIEW_DEVICE_LS_KEY = "wello-code-preview-device";

/** Zoom that fits `deviceWidth` into `availW` without ever enlarging past 1:1. */
export function fitZoom(deviceWidth: number, availW: number): number {
  if (deviceWidth <= 0 || availW <= 0) return 1;
  return Math.min(1, availW / deviceWidth);
}

/** Keep a custom device width within sane bounds. */
export function clampCustomWidth(width: number): number {
  if (!Number.isFinite(width)) return 375;
  return Math.max(320, Math.min(3840, Math.round(width)));
}

/**
 * Address-bar input → a loadable http/https URL (the preview pane's mini
 * browser). Scheme-less input gets http:// for local-network hosts and
 * https:// otherwise; anything unparsable (or a non-web scheme) → null.
 */
export function normalizeAddress(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  // "scheme:" = letters then a colon NOT followed by a digit — so file:///…,
  // javascript:… parse as-is (and get rejected below), while host:port input
  // like localhost:5173 is NOT mistaken for a scheme and gets prefixed.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s);
  const withScheme = hasScheme
    ? s
    : (/^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.)/i.test(s) ? "http://" : "https://") + s;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Google search for address-bar input that isn't a URL. */
export function searchUrl(query: string): string {
  return "https://www.google.com/search?q=" + encodeURIComponent(query);
}

/**
 * Address-bar input → what to actually load: a URL when it looks like one,
 * otherwise a Google search (browser omnibox behavior). Spaces always mean a
 * query; a bare dotless word ("гугл", "hello") is a query too — unless the
 * user was explicit with a scheme or a port, or it's a local host.
 */
export function resolveAddressInput(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/\s/.test(s)) return searchUrl(s);
  const direct = normalizeAddress(s);
  if (!direct) return searchUrl(s);
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s);
  try {
    const u = new URL(direct);
    const local = /^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.)/i.test(u.hostname);
    if (!hasScheme && !u.port && !local && !u.hostname.includes(".")) return searchUrl(s);
  } catch {
    return searchUrl(s);
  }
  return direct;
}
