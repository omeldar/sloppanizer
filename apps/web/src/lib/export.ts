import type { QueryClient } from "@tanstack/react-query";
import { downloadFile } from "./download.ts";
import { keys } from "./queries.ts";

const pad = (n: number) => String(n).padStart(2, "0");

/** `sloppanizer-export-YYYYMMDD-HHmmss.zip`, in case the server's name does not reach the page. */
export function exportFileName(now: Date): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `sloppanizer-export-${date}-${time}.zip`;
}

/** Downloads the zip; the server records the export time, so the status bar refreshes after it. */
export async function downloadExport(client: QueryClient): Promise<void> {
  await downloadFile("/export.zip", exportFileName(new Date()));
  void client.invalidateQueries({ queryKey: keys.stats });
}
