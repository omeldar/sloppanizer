import { Attachment } from "@organizer/shared";
import { api } from "./api.ts";

/** Stores one file (any type, up to 25 MB); the server names and types it from its content. */
export function uploadAttachment(file: File): Promise<Attachment> {
  return api(Attachment, "/attachments", {
    method: "POST",
    raw: file,
    query: { name: file.name || "file" },
  });
}
