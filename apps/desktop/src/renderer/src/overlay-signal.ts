import { useEffect } from "react";

/**
 * Full-screen overlays (modals, palette, lightbox) paint in the DOM — UNDER the
 * native preview browser surface, which composites above everything. Each
 * overlay announces itself for its lifetime; the preview pane counts the
 * announcements and hides the browser surface while any overlay is open.
 */
export function useOverlayMark(): void {
  useEffect(() => {
    window.dispatchEvent(new Event("wello-overlay-open"));
    return () => {
      window.dispatchEvent(new Event("wello-overlay-close"));
    };
  }, []);
}
