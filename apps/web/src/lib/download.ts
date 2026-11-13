import { apiFile } from "./api.ts";

/**
 * Downloads go through fetch with the tab's token, then a short-lived blob URL: a plain link to the API
 * would carry no token (and a token in the URL would end up in logs and the history).
 */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // The browser has taken the file once the click ran; a moment later the URL can go.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Fetches an API file and saves it under the server's name, else `fallbackName`. */
export async function downloadFile(path: string, fallbackName: string): Promise<string> {
  const { blob, fileName } = await apiFile(path);
  const name = fileName ?? fallbackName;
  saveBlob(blob, name);
  return name;
}
