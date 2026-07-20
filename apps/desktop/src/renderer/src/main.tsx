import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@wello-code/design-system/tokens.css";
import "./app.css";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { IS_MAC } from "./hotkeys";
import { initTheme } from "./Settings";

// Lets CSS branch on the platform. Needed because macOS puts its window buttons
// INSIDE our title bar, on the left, where our own controls live. Set before the
// first render so the bar is never painted without the reserved space.
document.documentElement.dataset.platform = IS_MAC ? "mac" : "other";

initTheme();

const container = document.getElementById("root");
if (!container) throw new Error("Root container #root not found");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
