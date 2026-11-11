import { API_PREFIX } from "@organizer/shared";
import type { QueryClient } from "@tanstack/react-query";
import { keys } from "./queries.ts";

export const EXPORT_URL = `${API_PREFIX}/export.zip`;

/** Starts the zip download; the server records the export time, so the status bar refreshes after it. */
export function downloadExport(client: QueryClient): void {
  const link = document.createElement("a");
  link.href = EXPORT_URL;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => void client.invalidateQueries({ queryKey: keys.stats }), 1500);
}
