import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { useOverlayMark } from "./overlay-signal";
import { useFocusTrap } from "./use-focus-trap";

/**
 * Attached-image previews in the chat + the full-screen lightbox (the same UX as
 * web Wello's message images, restyled for Wello Code). Images are local files;
 * the renderer's CSP only allows data: URLs, so bytes come over IPC and are
 * cached per path for the session.
 */

const dataUrlCache = new Map<string, Promise<string | null>>();

function loadImage(path: string): Promise<string | null> {
  let pending = dataUrlCache.get(path);
  if (!pending) {
    pending = window.wello.readImageData(path).catch(() => null);
    dataUrlCache.set(path, pending);
  }
  return pending;
}

/** undefined = loading, null = unavailable (deleted/oversized), string = data URL. */
function useImageData(path: string): string | null | undefined {
  const [data, setData] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setData(undefined);
    void loadImage(path).then((d) => {
      if (alive) setData(d);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return data;
}

/**
 * The tiny thumbnail inside a composer chip. Pasted images carry a ready data-URL
 * preview; picked/dropped ones load from disk through the same cache.
 */
export function AttachThumb({ path, preview }: { path: string; preview?: string }) {
  const loaded = useImageData(path);
  const src = preview ?? (typeof loaded === "string" ? loaded : undefined);
  if (!src) return <Icon name="image" size={12} />;
  return <img className="attachchip__thumb" src={src} alt="" />;
}

/** Thumbnails of a user message's attached images; click opens the lightbox. */
export function ChatImages({ paths, onOpen }: { paths: string[]; onOpen: (index: number) => void }) {
  return (
    <div className="chatimgs">
      {paths.map((path, i) => (
        <ChatImage key={`${i}-${path}`} path={path} onOpen={() => onOpen(i)} />
      ))}
    </div>
  );
}

function ChatImage({ path, onOpen }: { path: string; onOpen: () => void }) {
  const data = useImageData(path);
  if (data === null) {
    // The file is gone (pastes are cleaned up after 14 days) — a quiet husk, not a broken img.
    return (
      <span className="chatimg chatimg--missing" title="Изображение недоступно">
        <Icon name="image" size={15} />
      </span>
    );
  }
  return (
    <button
      type="button"
      className="chatimg"
      title="Открыть изображение"
      aria-label="Открыть изображение"
      disabled={!data}
      onClick={onOpen}
    >
      {data ? <img src={data} alt="" /> : <span className="chatimg__ph" aria-hidden />}
    </button>
  );
}

/**
 * Full-screen viewer: Esc/backdrop closes, ←/→ page within the message's images,
 * click toggles fit ↔ 1:1 zoom (scrollable when zoomed).
 */
export function Lightbox({
  paths,
  index,
  onIndex,
  onClose,
}: {
  paths: string[];
  index: number;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const [zoomed, setZoomed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useFocusTrap(rootRef);
  useOverlayMark();
  const count = paths.length;
  const hasNav = count > 1;
  const safeIndex = Math.min(Math.max(index, 0), count - 1);
  const path = paths[safeIndex] ?? "";
  const data = useImageData(path);
  // Dismiss = play the shared 150ms overlay fade-out, then let the parent unmount us.
  const [leaving, setLeaving] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismiss = (): void => {
    setLeaving((prev) => {
      if (!prev) window.setTimeout(() => closeRef.current(), 150);
      return true;
    });
  };

  // A new image always opens fitted, not inheriting the previous zoom.
  useEffect(() => setZoomed(false), [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") dismiss();
      else if (e.key === "ArrowRight" && hasNav) onIndex((safeIndex + 1) % count);
      else if (e.key === "ArrowLeft" && hasNav) onIndex((safeIndex - 1 + count) % count);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [safeIndex, count, hasNav, onIndex]);

  return (
    <div
      className={`lightbox ${leaving ? "is-leaving" : ""}`}
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр изображения"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="lightbox__top">
        <button
          type="button"
          className="lightbox__btn"
          title={zoomed ? "Уменьшить" : "Увеличить"}
          aria-label={zoomed ? "Уменьшить" : "Увеличить"}
          aria-pressed={zoomed}
          onClick={() => setZoomed((z) => !z)}
        >
          <Icon name={zoomed ? "zoomout" : "zoomin"} size={15} />
        </button>
        <button
          type="button"
          className="lightbox__btn"
          title="Закрыть"
          aria-label="Закрыть"
          onClick={dismiss}
        >
          <Icon name="x" size={15} />
        </button>
      </div>
      {hasNav ? (
        <>
          <button
            type="button"
            className="lightbox__btn lightbox__nav lightbox__nav--prev"
            title="Предыдущее"
            aria-label="Предыдущее"
            onClick={() => onIndex((safeIndex - 1 + count) % count)}
          >
            <Icon name="back" size={15} />
          </button>
          <button
            type="button"
            className="lightbox__btn lightbox__nav lightbox__nav--next"
            title="Следующее"
            aria-label="Следующее"
            onClick={() => onIndex((safeIndex + 1) % count)}
          >
            <Icon name="chevron" size={15} />
          </button>
          <span className="lightbox__counter">
            {safeIndex + 1} из {count}
          </span>
        </>
      ) : null}
      {data ? (
        <img
          className={`lightbox__img ${zoomed ? "is-zoomed" : ""}`}
          src={data}
          alt="Изображение"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setZoomed((z) => !z)}
        />
      ) : (
        <span className="lightbox__loading">{data === null ? "Изображение недоступно" : "Загрузка…"}</span>
      )}
    </div>
  );
}
