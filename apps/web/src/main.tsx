// Placeholder entry; the web builder replaces it.
import { formatDuration } from "@organizer/shared";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <p>organizer {formatDuration(0)}</p>
    </StrictMode>,
  );
}
