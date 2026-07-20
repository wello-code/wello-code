/**
 * Design-system entrypoint. The CSS custom properties live in `tokens.css` (import
 * it once at the app root: `import "@wello-code/design-system/tokens.css"`). Feature
 * code must reference semantic tokens via `var(--…)` — never raw color/spacing
 * literals (enforced by `pnpm --filter @wello-code/design-system lint:tokens`).
 *
 * React primitives (Button, IconButton, Input, Panel, MenuItem) land in Phase 1,
 * where they're built against the shell and verified visually.
 */

/** Reference a CSS custom property, e.g. `cssVar("--surface-1")` → `"var(--surface-1)"`. */
export function cssVar(name: `--${string}`): string {
  return `var(${name})`;
}

/** Package-relative path to the token stylesheet, for tooling that needs it. */
export const TOKENS_CSS_PATH = "tokens.css";
