import type { ReactNode } from "react";

export type IconName =
  | "file"
  | "terminal"
  | "search"
  | "globe"
  | "edit"
  | "check"
  | "x"
  | "subagent"
  | "send"
  | "stop"
  | "chevron"
  | "chevrondown"
  | "chevronup"
  | "forward"
  | "user"
  | "expand"
  | "collapse"
  | "dot"
  | "folder"
  | "plus"
  | "gear"
  | "copy"
  | "rocket"
  | "wrench"
  | "shieldcheck"
  | "bug"
  | "sidebar"
  | "panel"
  | "undo"
  | "power"
  | "compose"
  | "external"
  | "back"
  | "dots"
  | "pin"
  | "attach"
  | "trash"
  | "grip"
  | "image"
  | "zoomin"
  | "zoomout"
  | "wallet"
  | "sun"
  | "keyboard"
  | "gitbranch";

// 16×16 grid, outline, currentColor (DESIGN_EXTENSION_SPEC §5).
const PATHS: Record<IconName, ReactNode> = {
  file: (
    <>
      <path d="M4 1.75h5l3.25 3.25V14.25H4z" />
      <path d="M9 1.75V5h3.25" />
    </>
  ),
  folder: <path d="M2 4.25h3.5l1.25 1.5H14v7.5H2z" />,
  terminal: (
    <>
      <path d="M2.75 3.5l3 3-3 3" />
      <path d="M7.75 10.5h5.5" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.25 3.25" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11M8 2.5c2.2 2 2.2 9 0 11M8 2.5c-2.2 2-2.2 9 0 11" />
    </>
  ),
  edit: <path d="M10.75 2.25l3 3-8 8H2.75v-3z" />,
  check: <path d="M3.25 8.5l3 3 6.25-6.75" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  subagent: (
    <>
      <circle cx="4" cy="4" r="1.4" />
      <circle cx="4" cy="12" r="1.4" />
      <circle cx="12" cy="8" r="1.4" />
      <path d="M4 5.4v5.2M5.4 4.7l5.2 2.6M5.4 11.3l5.2-2.6" />
    </>
  ),
  send: <path d="M8 13V3.5M8 3.5l-4 4M8 3.5l4 4" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />,
  chevron: <path d="M6 4l4 4-4 4" />,
  chevrondown: <path d="M4 6l4 4 4-4" />,
  chevronup: <path d="M4 10l4-4 4 4" />,
  // Diagonal grow/shrink arrows (panel wide-mode toggle, Claude Code style).
  expand: (
    <path d="M9.5 2.75h3.75v3.75M13 3l-4.25 4.25M6.5 13.25H2.75V9.5M3 13l4.25-4.25" />
  ),
  collapse: (
    <path d="M13.25 6.5H9.5V2.75M9.75 6.25L13.5 2.5M2.75 9.5H6.5v3.75M6.25 9.75L2.5 13.5" />
  ),
  dot: <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />,
  plus: <path d="M8 3.25v9.5M3.25 8h9.5" />,
  gear: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.6v2.1M8 12.3v2.1M1.6 8h2.1M12.3 8h2.1M3.5 3.5l1.5 1.5M11 11l1.5 1.5M12.5 3.5l-1.5 1.5M5 11l-1.5 1.5" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-1a1.5 1.5 0 0 0-1.5-1.5H4a1.5 1.5 0 0 0-1.5 1.5V9A1.5 1.5 0 0 0 4 10.5h1" />
    </>
  ),
  // Neutral account glyph (sidebar footer's avatar).
  user: (
    <>
      <circle cx="8" cy="5.4" r="2.6" />
      <path d="M2.9 13.4a5.3 5.3 0 0 1 10.2 0" />
    </>
  ),
  rocket: (
    <>
      <path d="M9.2 10.6c2.7-1.9 4.4-4.7 4-8-3.3-.4-6.1 1.3-8 4l-2.9.7L4.7 9.7l2.4 2.4 2.1-1.5z" />
      <circle cx="10" cy="6" r="1.1" />
      <path d="M4.6 11.4c-1 .3-1.9 1.5-2.1 2.9 1.4-.2 2.6-1.1 2.9-2.1" />
    </>
  ),
  wrench: (
    <path d="M9.3 3.2a3.4 3.4 0 0 1 4.2-.6l-2.4 2.5.9 1.7 1.7.9 2.5-2.4v0a3.4 3.4 0 0 1-4.7 3.9L6.3 14.4a1.6 1.6 0 0 1-2.3-2.3l5.2-5.2a3.4 3.4 0 0 1 .1-3.7z" />
  ),
  shieldcheck: (
    <>
      <path d="M8 1.75L13.25 3.6v4.15c0 3.1-2.2 5.4-5.25 6.5-3.05-1.1-5.25-3.4-5.25-6.5V3.6z" />
      <path d="M5.6 8l1.7 1.7 3.1-3.4" />
    </>
  ),
  bug: (
    <>
      <path d="M5.75 6.5a2.25 2.25 0 0 1 4.5 0v3.75a2.25 2.25 0 1 1-4.5 0z" />
      <path d="M6 4.5c0-1.1.9-2 2-2s2 .9 2 2" />
      <path d="M5.75 7.5H2.9M5.75 9.5l-2.5 2.3M13.1 7.5h-2.85M12.75 11.8l-2.5-2.3" />
    </>
  ),
  sidebar: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M6 2.75v10.5" />
    </>
  ),
  panel: (
    <>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d="M10 2.75v10.5" />
    </>
  ),
  undo: (
    <>
      <path d="M3.25 4v3.25H6.5" />
      <path d="M3.4 7.25A5 5 0 1 1 5 11.4" />
    </>
  ),
  power: (
    <>
      <path d="M8 1.9v5.1" />
      <path d="M4.6 4.2a5.3 5.3 0 1 0 6.8 0" />
    </>
  ),
  compose: (
    <>
      <path d="M13.25 8.75v3.5a2 2 0 0 1-2 2h-7.5a2 2 0 0 1-2-2v-7.5a2 2 0 0 1 2-2h3.5" />
      <path d="M12.1 1.9l2 2-6.35 6.35-2.5.5.5-2.5z" />
    </>
  ),
  external: (
    <>
      <path d="M12.5 8.75v3.5a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5V5a1.5 1.5 0 0 1 1.5-1.5h3.5" />
      <path d="M9.75 2.25h4v4M13.5 2.5L7.75 8.25" />
    </>
  ),
  back: <path d="M9.5 3.5L5 8l4.5 4.5" />,
  forward: <path d="M6.5 3.5L11 8l-4.5 4.5" />,
  dots: (
    <>
      <circle cx="3.2" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12.8" cy="8" r="1.15" fill="currentColor" stroke="none" />
    </>
  ),
  pin: (
    <>
      <path d="M6 2.25h4l.5 4.25 2 2v1H3.5v-1l2-2z" />
      <path d="M8 9.5v4.25" />
    </>
  ),
  attach: (
    <path d="M13.2 7.2l-4.9 4.9a3.1 3.1 0 0 1-4.4-4.4l5.3-5.3a2.1 2.1 0 0 1 3 3l-5.3 5.3a1.1 1.1 0 0 1-1.6-1.6l4.9-4.9" />
  ),
  trash: (
    <>
      <path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4 4.25l.75 9h6.5l.75-9" />
      <path d="M6.5 6.75v4M9.5 6.75v4" />
    </>
  ),
  // Six-dot drag handle for reorderable pinned chats (as in web Wello's sidebar).
  grip: (
    <>
      <circle cx="6" cy="3.6" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="10" cy="3.6" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="6" cy="8" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="10" cy="8" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="6" cy="12.4" r="1.05" fill="currentColor" stroke="none" />
      <circle cx="10" cy="12.4" r="1.05" fill="currentColor" stroke="none" />
    </>
  ),
  image: (
    <>
      <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="1.5" />
      <circle cx="6" cy="6.75" r="1.1" />
      <path d="M4 12.25l3.5-3.5 2 2 2-2 2.25 2.25" />
    </>
  ),
  zoomin: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.25 3.25M5.4 7h3.2M7 5.4v3.2" />
    </>
  ),
  zoomout: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.25 3.25M5.4 7h3.2" />
    </>
  ),
  // Wallet with a card pocket — the Wello balance chip in the titlebar.
  wallet: (
    <>
      <rect x="2" y="4" width="12" height="8" rx="1.75" />
      <path d="M10 6.5h4v3h-4a1.5 1.5 0 0 1 0-3z" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.75M8 12.75v1.75M1.5 8h1.75M12.75 8h1.75M3.4 3.4l1.24 1.24M11.36 11.36l1.24 1.24M12.6 3.4l-1.24 1.24M4.64 11.36L3.4 12.6" />
    </>
  ),
  keyboard: (
    <>
      <rect x="1.75" y="4" width="12.5" height="8" rx="1.75" />
      <path d="M4.25 6.75h.01M6.75 6.75h.01M9.25 6.75h.01M11.75 6.75h.01M5 9.5h6" />
    </>
  ),
  gitbranch: (
    <>
      <circle cx="4.5" cy="3.75" r="1.75" />
      <circle cx="4.5" cy="12.25" r="1.75" />
      <circle cx="11.5" cy="5.25" r="1.75" />
      <path d="M4.5 5.5v5M11.5 7c0 2.5-3 3-5 3.5" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
