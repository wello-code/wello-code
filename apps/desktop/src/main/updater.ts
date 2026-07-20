import { app } from "electron";
import electronUpdater from "electron-updater";
import type { NsisUpdater } from "electron-updater";
import type { UpdateStatus } from "../shared/ipc-api";
import { log } from "./logger";

/**
 * Auto-update over GitHub Releases.
 *
 * Why a real updater and not a "new version available" link: our own code is about
 * 2 MB of a ~132 MB installer, the rest being Electron and the agent binary, which
 * change only on a dependency bump. electron-builder emits a .blockmap next to each
 * installer, so electron-updater diffs the two block maps and fetches only the
 * changed ranges over HTTP range requests. A routine update is a couple of
 * megabytes; asking people to re-download 132 MB by hand means nobody updates.
 * If anything about the diff fails it silently falls back to the full download.
 *
 * Nothing happens without the user: `autoDownload` and `autoInstallOnAppQuit` are
 * both off, so we only ever report that an update exists and act on an explicit
 * click. A background download of a hundred-odd megabytes on someone's tethered
 * connection is not ours to start.
 */

// electron-updater is CommonJS and has no ESM named exports.
const { autoUpdater } = electronUpdater;

type Emit = (status: UpdateStatus) => void;

let emit: Emit = () => {};
let latest: UpdateStatus = { state: "idle" };

/** Last known status, so a renderer that mounts late still sees it. */
export function updateStatus(): UpdateStatus {
  return latest;
}

function set(status: UpdateStatus): void {
  latest = status;
  emit(status);
}

export function initUpdater(send: Emit): void {
  emit = send;

  // A dev run has no packaged app and no feed; pretending otherwise just throws.
  if (!app.isPackaged) {
    latest = { state: "unsupported" };
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (m: unknown) => log.info(`updater: ${String(m)}`),
    warn: (m: unknown) => log.warn(`updater: ${String(m)}`),
    error: (m: unknown) => log.error(`updater: ${String(m)}`),
    debug: () => {},
  };

  // Set the feed in code rather than relying on app-update.yml: electron-builder
  // writes that file while packing the app, and we run it with --prepackaged, so
  // the file is not guaranteed to be there.
  autoUpdater.setFeedURL({ provider: "github", owner: "wello-code", repo: "wello-code" });

  // The build is not code-signed, so there is no publisher name to verify and the
  // default check would fail every update. What still protects the download: the
  // feed and the artifact come from GitHub over HTTPS, and electron-updater checks
  // the SHA-512 from latest.yml against the downloaded file before installing.
  // The trust anchor is "whoever can publish a GitHub release for this repo".
  // Revisit once a certificate exists.
  (autoUpdater as NsisUpdater).verifyUpdateCodeSignature = () => Promise.resolve(null);

  autoUpdater.on("checking-for-update", () => set({ state: "checking" }));
  autoUpdater.on("update-available", (info) => set({ state: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => set({ state: "none" }));
  autoUpdater.on("download-progress", (p) =>
    set({ state: "downloading", percent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) => set({ state: "ready", version: info.version }));
  autoUpdater.on("error", (err) => {
    log.error("updater failed", err);
    set({ state: "error", message: err instanceof Error ? err.message : String(err) });
  });
}

/** Ask GitHub whether a newer release exists. Never throws at the caller. */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // Offline, rate-limited, no releases yet: an update check must never be an
    // error the user has to deal with.
    log.warn("update check failed", err);
    set({ state: "error", message: "Не удалось проверить обновления" });
  }
}

/** Pull the update the user just agreed to. */
export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) return;
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    log.error("update download failed", err);
    set({ state: "error", message: "Не удалось скачать обновление" });
  }
}

/**
 * Restart into the installer. Quitting runs the app's normal before-quit path, so
 * an agent run in flight is cancelled rather than orphaned.
 */
export function installUpdate(): void {
  if (!app.isPackaged || latest.state !== "ready") return;
  log.info("installing update, quitting");
  autoUpdater.quitAndInstall();
}
