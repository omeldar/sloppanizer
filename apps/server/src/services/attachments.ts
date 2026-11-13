import { API_PREFIX, type Attachment, INLINE_IMAGE_TYPES } from "@organizer/shared";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { attachments } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import { insertOwnedRow, owned } from "./owned.ts";

export type AttachmentRow = typeof attachments.$inferSelect;

export const OCTET_STREAM = "application/octet-stream";
const MAX_NAME = 100;

const startsWith = (bytes: Buffer, prefix: readonly number[], offset = 0): boolean =>
  bytes.length >= offset + prefix.length && prefix.every((b, i) => bytes[offset + i] === b);
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

/** File types we recognise by their first bytes, with the extension a default name gets. */
const SIGNATURES: { mime: string; ext: string; test: (bytes: Buffer) => boolean }[] = [
  {
    mime: "image/png",
    ext: ".png",
    test: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  { mime: "image/jpeg", ext: ".jpg", test: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  {
    mime: "image/gif",
    ext: ".gif",
    test: (b) => startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a")),
  },
  {
    mime: "image/webp",
    ext: ".webp",
    test: (b) => startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8),
  },
  { mime: "application/pdf", ext: ".pdf", test: (b) => startsWith(b, ascii("%PDF")) },
];

/**
 * The stored type, from the magic bytes only (the client's Content-Type is never trusted):
 * png, jpeg, gif, webp, pdf; everything else (svg, html, zip, text) is application/octet-stream.
 */
export function detectType(bytes: Buffer): { mime: string; ext: string } {
  const match = SIGNATURES.find((s) => s.test(bytes));
  return match ? { mime: match.mime, ext: match.ext } : { mime: OCTET_STREAM, ext: "" };
}

export const isInline = (mime: string): boolean => (INLINE_IMAGE_TYPES as readonly string[]).includes(mime);

/**
 * A safe file name: only [A-Za-z0-9._-] (others become "-"), no leading dots, at most 100 characters
 * (the extension is kept). Empty: "file" plus the extension of the type. "meta" is reserved by the
 * /attachments/:id/meta route.
 */
export function sanitizeName(raw: string | undefined, ext: string): string {
  const base = (raw ?? "").split(/[/\\]/).pop() ?? "";
  let name = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf(".");
    const extension = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, MAX_NAME - extension.length) + extension;
  }
  if (!/[A-Za-z0-9]/.test(name)) name = `file${ext}`;
  if (name === "meta") name = "meta-file";
  return name;
}

export const toAttachment = (row: AttachmentRow): Attachment => ({
  id: row.id,
  name: row.name,
  mimeType: row.mimeType,
  size: row.size,
  sha256: row.sha256,
  url: `${API_PREFIX}/attachments/${row.id}/${row.name}`,
  inline: isInline(row.mimeType),
  createdBy: row.createdBy,
  createdAt: row.createdAt,
});

/**
 * The folder of an account's files, <files dir>/<account id> (0700), made on first use. Attachment files
 * sit in it by id, so an account can only ever reach its own files.
 */
export function accountFilesDir(filesDir: string, accountId: number): string {
  const dir = join(filesDir, String(accountId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Bytes of the account's attachments (the rows; files are the same size). */
export function accountFilesBytes(sc: Scoped): number {
  return sc.db.get<{ n: number }>(
    sql`SELECT coalesce(sum(size), 0) AS n FROM ${attachments} WHERE account_id = ${sc.accountId}`,
  ).n;
}

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const sizeText = (bytes: number): string =>
  bytes >= GIB && bytes % GIB === 0 ? `${bytes / GIB} GB` : `${Math.round(bytes / MIB)} MB`;

/** 413 when the account's files would pass its limit with `adding` more bytes. */
export function assertFilesQuota(sc: Scoped, limitBytes: number, adding: number): void {
  if (accountFilesBytes(sc) + adding <= limitBytes) return;
  throw new ApiError(
    "too_large",
    `This account's files use ${sizeText(limitBytes)}, its limit. Delete unused files or ask the admin.`,
  );
}

/** Writes the bytes to a private temp file in the folder and flushes them to disk. */
function writeTemp(dir: string, bytes: Buffer): string {
  const path = join(dir, `.upload-${randomBytes(8).toString("hex")}`);
  const fd = openSync(path, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return path;
}

function syncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Some file systems cannot sync a folder; the file itself is already on disk.
  }
}

/**
 * Stores an upload of the account at <account files dir>/<id> (0600; no user input in the path): temp
 * file, fsync, then quota check, row and rename in one transaction. When anything fails, no file and no
 * row are left.
 */
export function storeAttachment(
  ctx: Ctx,
  files: { dir: string; limitBytes: number },
  actor: string,
  rawName: string | undefined,
  bytes: Buffer,
): Attachment {
  if (bytes.length === 0)
    throw new ApiError("validation_failed", "The file is empty. Pick a file with content.");
  const { mime, ext } = detectType(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { dir } = files;
  const temp = writeTemp(dir, bytes);
  let finalPath: string | null = null;
  try {
    const attachment = ctx.db.transaction((tx) => {
      const sc = inTx(ctx, tx);
      assertFilesQuota(sc, files.limitBytes, bytes.length);
      const id = insertOwnedRow(sc, attachments, {
        name: sanitizeName(rawName, ext),
        mimeType: mime,
        size: bytes.length,
        sha256,
        createdBy: actor,
        createdAt: now(ctx),
      });
      finalPath = join(dir, String(id));
      renameSync(temp, finalPath);
      return toAttachment(attachmentRow(sc, id));
    });
    syncDir(dir);
    return attachment;
  } catch (error) {
    rmSync(temp, { force: true });
    if (finalPath) rmSync(finalPath, { force: true });
    throw error;
  }
}

function attachmentRow(sc: Scoped, id: number): AttachmentRow {
  const row = sc.db
    .select()
    .from(attachments)
    .where(owned(sc, attachments, eq(attachments.id, id)))
    .get();
  if (!row) throw notFound("Attachment", id);
  return row;
}

export const getAttachment = (sc: Scoped, id: number): Attachment => toAttachment(attachmentRow(sc, id));

/**
 * The row and file path of an attachment of the account (`dir` = its files folder); 404 with a clear
 * message when the file is gone.
 */
export function attachmentFile(
  sc: Scoped,
  dir: string,
  id: number,
): { row: AttachmentRow; path: string; size: number } {
  const row = attachmentRow(sc, id);
  const path = join(dir, String(row.id));
  try {
    return { row, path, size: statSync(path).size };
  } catch {
    throw new ApiError(
      "not_found",
      `The file of attachment ${id} is missing from the data folder. Restore it from an export.`,
    );
  }
}
