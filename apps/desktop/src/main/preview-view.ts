/**
 * Native embedded browser for the preview pane — a WebContentsView overlaid on
 * the main window at the pane's rectangle. Unlike an <iframe>, this is a real
 * browser surface: sites that forbid embedding (X-Frame-Options / CSP
 * frame-ancestors bind only iframes) load fine, links, redirects and history
 * all behave. Isolation: sandboxed, no preload, its own session partition —
 * page JS can never reach window.wello or Node. The renderer owns geometry
 * (it sends the pane's rectangle); this module owns the web contents.
 */
import { BrowserWindow, session, WebContentsView } from "electron";

export interface PreviewViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type PreviewDevice = "mobile" | "tablet" | "desktop";

export interface PreviewNavState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

const PARTITION = "persist:wello-preview";
const DEVICE_WIDTH: Record<Exclude<PreviewDevice, "desktop">, number> = {
  mobile: 375,
  tablet: 768,
};

let view: WebContentsView | null = null;
let host: BrowserWindow | null = null;
let attached = false;
/** The URL the APP asked for — page-internal navigation must not fight it. */
let requestedUrl: string | null = null;
let device: PreviewDevice = "desktop";
let lastBounds: PreviewViewBounds = { x: 0, y: 0, width: 0, height: 0 };
/** disableDeviceEmulation() on a webContents that never emulated CRASHES
 *  Electron 33 on Windows natively (found the hard way) — track the state. */
let emulationOn = false;

function isWebUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:";
  } catch {
    return false;
  }
}

function sendState(): void {
  if (!view || !host || host.isDestroyed()) return;
  const wc = view.webContents;
  const state: PreviewNavState = {
    url: wc.getURL(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading(),
  };
  host.webContents.send("previewview.state", state);
}

/** Chrome-like device mode: lay the page out at true device CSS width and let
 *  the compositor scale it into the (already centered, renderer-sized) view.
 *  Both emulation calls are unsafe on a webContents with no page yet — they
 *  re-apply from dom-ready, so an early call is just deferred, never lost. */
function applyDevice(): void {
  if (!view || view.webContents.isDestroyed()) return;
  const wc = view.webContents;
  if (!wc.getURL()) return; // no page yet — dom-ready re-applies
  if (device === "desktop") {
    if (emulationOn) {
      emulationOn = false;
      wc.disableDeviceEmulation();
    }
    return;
  }
  const width = DEVICE_WIDTH[device];
  const scale = lastBounds.width > 0 ? Math.min(1, lastBounds.width / width) : 1;
  const height = Math.max(1, Math.round(lastBounds.height / scale));
  emulationOn = true;
  wc.enableDeviceEmulation({
    screenPosition: "mobile",
    screenSize: { width, height },
    viewSize: { width, height },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 0,
    scale,
  });
}

function ensureView(): WebContentsView {
  if (view && !view.webContents.isDestroyed()) return view;
  const part = session.fromPartition(PARTITION);
  // Untrusted web content: no mic/camera/geolocation/… and no silent downloads.
  part.setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
  part.setPermissionCheckHandler(() => false);
  part.removeAllListeners("will-download");
  part.on("will-download", (e) => e.preventDefault());
  view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  view.setBackgroundColor("#ffffffff"); // pages assume a white canvas
  try {
    view.setBorderRadius(10); // match the panel cards
  } catch {
    /* older runtime */
  }
  const wc = view.webContents;
  // Popups collapse into this same surface (a mini browser has one tab).
  wc.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void wc.loadURL(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (!isWebUrl(url)) e.preventDefault();
  });
  // Redirects and subframe navigations don't fire will-navigate — same gate.
  wc.on("will-redirect", (e, url) => {
    if (!isWebUrl(url)) e.preventDefault();
  });
  wc.on("will-frame-navigate", (e) => {
    if (!isWebUrl(e.url)) e.preventDefault();
  });
  wc.on("did-navigate", sendState);
  wc.on("did-navigate-in-page", sendState);
  wc.on("did-start-loading", sendState);
  wc.on("did-stop-loading", sendState);
  wc.on("did-fail-load", sendState);
  wc.on("dom-ready", applyDevice);
  return view;
}

export function previewViewShow(
  win: BrowserWindow,
  bounds: PreviewViewBounds,
  url: string | null,
  nextDevice: PreviewDevice,
): void {
  const v = ensureView();
  host = win;
  if (!attached) {
    win.contentView.addChildView(v);
    attached = true;
  }
  lastBounds = bounds;
  v.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  });
  device = nextDevice;
  applyDevice();
  if (url && url !== requestedUrl && isWebUrl(url)) {
    requestedUrl = url;
    void v.webContents.loadURL(url).catch(() => {
      /* did-fail-load already reported */
    });
  }
  sendState();
}

/** Detach (overlay opened / pane collapsed) — history and page state survive. */
export function previewViewHide(): void {
  if (!view || !host || host.isDestroyed() || !attached) return;
  host.contentView.removeChildView(view);
  attached = false;
}

/** Free the browser surface entirely (pane closed / window gone). */
export function previewViewDestroy(): void {
  previewViewHide();
  if (view && !view.webContents.isDestroyed()) view.webContents.close();
  view = null;
  host = null;
  attached = false;
  requestedUrl = null;
  device = "desktop";
  emulationOn = false;
}

export function previewViewBack(): void {
  const wc = view?.webContents;
  if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
}

export function previewViewForward(): void {
  const wc = view?.webContents;
  if (wc && !wc.isDestroyed() && wc.navigationHistory.canGoForward())
    wc.navigationHistory.goForward();
}

export function previewViewReload(): void {
  const wc = view?.webContents;
  if (wc && !wc.isDestroyed() && wc.getURL()) wc.reload();
}

/** Screenshot of the live preview surface (PNG bytes) — for "снимок агенту". */
export async function previewViewCapture(): Promise<Buffer | null> {
  const wc = view?.webContents;
  if (!wc || wc.isDestroyed() || !attached) return null;
  try {
    const img = await wc.capturePage();
    const png = img.toPNG();
    return png.length > 0 ? png : null;
  } catch {
    return null;
  }
}
