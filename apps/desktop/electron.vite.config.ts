import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// Bundle our TS workspace packages into the main/preload output (they ship no built
// JS). Keep real node_modules deps external — crucially @anthropic-ai/claude-agent-sdk,
// which spawns a bundled binary and must never be bundled itself.
const workspacePkgs = [
  "@wello-code/contracts",
  "@wello-code/agent-core",
  "@wello-code/agent-sdk",
  "@wello-code/design-system",
];

// electron-updater must be BUNDLED into the main output, not left external: the
// packaging script stages only the agent SDK into the app's node_modules (it is the
// one dependency that cannot be bundled), so an external updater would simply be
// missing at runtime. It and its deps are pure JS, so rollup handles them.
const bundledMainDeps = ["electron-updater"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [...workspacePkgs, ...bundledMainDeps] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: workspacePkgs })],
    build: {
      // Sandboxed preloads must be CommonJS. In an ESM package a bare `.js` file is
      // treated as ESM, so emit an explicit `.cjs` and load that from main.
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
