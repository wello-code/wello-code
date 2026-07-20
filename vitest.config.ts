import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests live next to package sources; pure renderer logic (reducers,
    // attachment limits) is testable too. The desktop e2e specs (*.spec.ts)
    // are Playwright-Electron and run separately via `test:e2e`.
    include: ["packages/**/*.test.ts", "apps/desktop/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/out/**"],
  },
});
