import { useEffect, useState } from "react";
import { Icon } from "./Icon";

/**
 * Lightweight in-app toasts (Claude-style): a single bottom-right stack for brief
 * confirmations ("Скопировано"), recoverable errors ("Ход не удался — Повторить")
 * and undo prompts. A module-level store + `toast()` function means callers don't
 * need a context provider threaded through the big App tree — just import and call.
 * The <Toaster/> region is mounted once at the app root and renders the live stack
 * into an aria-live area so a screen reader hears results too.
 */

export type ToastTone = "default" | "success" | "danger";

export interface ToastOptions {
  message: string;
  tone?: ToastTone;
  /** Auto-dismiss delay (ms). Default 3200; give undo toasts a bit longer. */
  durationMs?: number;
  /** One inline action (e.g. «Отменить» / «Повторить»); dismisses the toast when used. */
  action?: { label: string; onClick: () => void };
}

interface ToastItem extends ToastOptions {
  id: number;
}

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

function dismiss(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

/** Show a toast. Safe to call from any event handler. */
export function toast(opts: ToastOptions): void {
  const id = nextId++;
  items = [...items, { id, ...opts }];
  emit();
  window.setTimeout(() => dismiss(id), opts.durationMs ?? 3200);
}

/** The live toast stack. Mount once near the app root. */
export function Toaster(): React.JSX.Element | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = (): void => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="toaster" role="region" aria-label="Уведомления">
      <div className="toaster__list" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone ?? "default"} wello-rise`} role="status">
            <span className="toast__msg">{t.message}</span>
            {t.action ? (
              <button
                type="button"
                className="toast__action"
                onClick={() => {
                  t.action!.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="toast__x"
              aria-label="Закрыть уведомление"
              onClick={() => dismiss(t.id)}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
