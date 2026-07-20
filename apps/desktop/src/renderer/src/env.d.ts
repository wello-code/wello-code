/// <reference types="vite/client" />
import type { WelloApi } from "../../shared/ipc-api";

declare global {
  interface Window {
    /** Exposed by the preload contextBridge. The only bridge to the main process. */
    wello: WelloApi;
  }
}
