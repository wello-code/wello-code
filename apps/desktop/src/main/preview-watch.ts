import { watch, type FSWatcher } from "node:fs";

/** Heavy/noise paths whose churn shouldn't trigger a preview reload. */
const IGNORE = /[\\/](node_modules|\.git|\.next|\.nuxt|coverage|\.cache|\.turbo)[\\/]/;

/**
 * Debounced recursive watch of the preview root — fires `onChange` ~200ms after the
 * last write so the preview auto-reloads. Best-effort: win32 recursive watch can
 * throw on some filesystems, in which case we simply degrade to no auto-refresh
 * (the toolbar reload button still works). Returns a disposer.
 */
export function watchPreview(root: string, onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (filename && IGNORE.test(`/${String(filename)}/`)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 200);
    });
    watcher.on("error", () => undefined);
  } catch {
    watcher = null;
  }
  return () => {
    if (timer) clearTimeout(timer);
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
  };
}
