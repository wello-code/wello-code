import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@wello-code/design-system/tokens.css";
import "./app.css";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { initTheme } from "./Settings";

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
