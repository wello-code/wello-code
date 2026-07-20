import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import { useOverlayMark } from "./overlay-signal";
import { useFocusTrap } from "./use-focus-trap";

/**
 * THE shared modal shell (moved out of App.tsx so Settings and the branch
 * popover can open dialogs too): one dimmed-and-blurred overlay + centered
 * card. Escape / overlay-click / the × dismiss through a 150ms fade-out before
 * the parent unmounts the dialog; opening fades in symmetrically (CSS).
 */
const ModalDismissCtx = createContext<(() => void) | null>(null);
export function useModalDismiss(fallback: () => void): () => void {
  return useContext(ModalDismissCtx) ?? fallback;
}

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismiss = useCallback(() => {
    setLeaving((prev) => {
      if (!prev) window.setTimeout(() => closeRef.current(), 150);
      return true;
    });
  }, []);
  useFocusTrap(cardRef);
  useOverlayMark();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss]);
  return (
    <div
      className={`modal ${leaving ? "is-leaving" : ""}`}
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && dismiss()}
    >
      <div className="modal__card wello-rise" ref={cardRef} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head">
          <strong className="modal__title">{title}</strong>
          <button className="icon-button" title="Закрыть" aria-label="Закрыть" onClick={dismiss}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <ModalDismissCtx.Provider value={dismiss}>{children}</ModalDismissCtx.Provider>
      </div>
    </div>
  );
}

/** A cancel button that dismisses through the shared overlay (fade-out). It must
 *  be its own component: the dismiss context only exists INSIDE Modal's subtree. */
export function ModalCancel({
  fallback,
  autoFocus,
  children,
}: {
  fallback: () => void;
  autoFocus?: boolean;
  children: ReactNode;
}) {
  const dismiss = useModalDismiss(fallback);
  return (
    <button className="button ghost sm" autoFocus={autoFocus} onClick={dismiss}>
      {children}
    </button>
  );
}
