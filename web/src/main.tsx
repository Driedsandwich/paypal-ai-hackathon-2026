import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Self-hosted fonts (OFL-1.1): Noto Serif JP for headings and ledger numbers, Noto Sans JP for UI.
import "@fontsource/noto-sans-jp/400.css";
import "@fontsource/noto-sans-jp/700.css";
import "@fontsource/noto-serif-jp/600.css";
import "@fontsource/noto-serif-jp/700.css";
import "./styles.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
