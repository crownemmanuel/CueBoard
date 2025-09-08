import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import logoUrl from "./cue-board.logo.png";

// Ensure title and favicon reflect CueBoard branding at runtime (dev and build)
const doc = document;
if (doc && doc.title !== "CueBoard") {
  doc.title = "CueBoard";
}
const ensureFavicon = () => {
  const link =
    doc.querySelector("link#app-favicon") || doc.createElement("link");
  link.id = "app-favicon";
  link.rel = "icon";
  link.href = logoUrl;
  const head = doc.querySelector("head");
  if (head && !link.parentElement) head.appendChild(link);
};
ensureFavicon();

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
