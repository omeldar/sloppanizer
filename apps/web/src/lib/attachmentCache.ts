import { API_PREFIX } from "@organizer/shared";
import { apiFile } from "./api.ts";

/**
 * Pasted images load through fetch with the tab's token. The blobs stay in memory for this page load
 * (by attachment id, at most 50 MB, oldest out), so going back to a todo does not load them again.
 */
export const IMAGE_CACHE_BYTES = 50 * 1024 * 1024;

const blobs = new Map<string, Blob>();
const loading = new Map<string, Promise<Blob>>();
let cachedBytes = 0;

/** "/api/v1/attachments/12/shot.png" -> "12". */
export function attachmentId(src: string): string {
  return src.slice(`${API_PREFIX}/attachments/`.length).split("/")[0] ?? src;
}

export function attachmentBlob(src: string): Promise<Blob> {
  const id = attachmentId(src);
  const cached = blobs.get(id);
  if (cached) {
    // Used again: it moves to the young end.
    blobs.delete(id);
    blobs.set(id, cached);
    return Promise.resolve(cached);
  }
  const pending = loading.get(id);
  if (pending) return pending;
  const load = apiFile(src.slice(API_PREFIX.length))
    .then(({ blob }) => {
      remember(id, blob);
      return blob;
    })
    .finally(() => loading.delete(id));
  loading.set(id, load);
  return load;
}

function remember(id: string, blob: Blob): void {
  if (blob.size > IMAGE_CACHE_BYTES) return;
  blobs.set(id, blob);
  cachedBytes += blob.size;
  for (const [oldId, old] of blobs) {
    if (cachedBytes <= IMAGE_CACHE_BYTES) break;
    blobs.delete(oldId);
    cachedBytes -= old.size;
  }
}

/** For tests. */
export function clearAttachmentCache(): void {
  blobs.clear();
  loading.clear();
  cachedBytes = 0;
}
