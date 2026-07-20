import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Contain keyboard focus inside an overlay while it is open, and return focus to
 * the opener when it closes. Without this, `aria-modal="true"` is a broken promise:
 * Tab walks focus into the page behind the dialog/lightbox.
 */
export function useFocusTrap(rootRef: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;
    const opener = document.activeElement as HTMLElement | null;

    const items = (): HTMLElement[] =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);

    // Pull focus in if it isn't already (respects an existing autoFocus).
    if (!root.contains(document.activeElement)) (items()[0] ?? root).focus();

    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      const list = items();
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      // Restore focus to whatever opened the overlay (no-op if it unmounted).
      opener?.focus?.();
    };
  }, [active, rootRef]);
}
