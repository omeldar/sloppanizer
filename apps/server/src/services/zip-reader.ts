import { Inflate } from "fflate";

/**
 * A small reader for uploaded zip archives. It lists entries from the central directory (so
 * duplicate names can be found, which a plain unzip silently merges) and inflates one entry at a
 * time in chunks with a hard cap on the real output, so a zip bomb fails early instead of filling
 * memory. Entry names are only compared, never used as paths.
 */

export class ZipError extends Error {}

export interface ZipEntryInfo {
  name: string;
  method: number;
  compressedSize: number;
  /** Uncompressed size from the central directory (checked against the real output). */
  size: number;
  localOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const CHUNK = 64 * 1024;

export function readCentralDirectory(zip: Buffer): ZipEntryInfo[] {
  if (zip.length < 22) throw new ZipError("The file is not a zip archive.");
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 65_535); at -= 1) {
    if (zip.readUInt32LE(at) === EOCD) {
      end = at;
      break;
    }
  }
  if (end === -1) throw new ZipError("The file is not a zip archive.");
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const offset = zip.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ZipError("Zip64 archives are not supported.");
  }
  if (offset + size > end) throw new ZipError("The zip archive is damaged (central directory).");
  const entries: ZipEntryInfo[] = [];
  let at = offset;
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > end || zip.readUInt32LE(at) !== CENTRAL) {
      throw new ZipError("The zip archive is damaged (central directory).");
    }
    const flags = zip.readUInt16LE(at + 8);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const nameBytes = zip.subarray(at + 46, at + 46 + nameLength);
    const entry: ZipEntryInfo = {
      // Bit 11: UTF-8 names; older tools write CP437, which matches latin1 for plain ASCII names.
      name: nameBytes.toString(flags & 0x800 ? "utf8" : "latin1"),
      method: zip.readUInt16LE(at + 10),
      compressedSize: zip.readUInt32LE(at + 20),
      size: zip.readUInt32LE(at + 24),
      localOffset: zip.readUInt32LE(at + 42),
    };
    if (
      entry.compressedSize === 0xffffffff ||
      entry.size === 0xffffffff ||
      entry.localOffset === 0xffffffff
    ) {
      throw new ZipError("Zip64 archives are not supported.");
    }
    entries.push(entry);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Inflates one entry and hands the output to `onChunk` in pieces. Throws ZipError when the real
 * output passes `maxBytes`, differs from the size in the directory, or the data is damaged.
 * Returns the number of bytes produced.
 */
export function inflateEntry(
  zip: Buffer,
  entry: ZipEntryInfo,
  maxBytes: number,
  onChunk: (chunk: Uint8Array) => void,
): number {
  const at = entry.localOffset;
  if (at + 30 > zip.length || zip.readUInt32LE(at) !== LOCAL) {
    throw new ZipError(`The zip archive is damaged (entry ${entry.name}).`);
  }
  const start = at + 30 + zip.readUInt16LE(at + 26) + zip.readUInt16LE(at + 28);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize)
    throw new ZipError(`The zip archive is cut off (entry ${entry.name}).`);
  let total = 0;
  const take = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > maxBytes) throw new ZipError(`${entry.name} is larger than allowed when unpacked.`);
    onChunk(chunk);
  };
  if (entry.method === 0) {
    take(data);
  } else if (entry.method === 8) {
    const inflater = new Inflate((chunk) => take(chunk));
    try {
      for (let i = 0; i < data.length || i === 0; i += CHUNK) {
        inflater.push(data.subarray(i, i + CHUNK), i + CHUNK >= data.length);
      }
    } catch (error) {
      if (error instanceof ZipError) throw error;
      throw new ZipError(`The zip archive is damaged (entry ${entry.name}).`);
    }
  } else {
    throw new ZipError(`Entry ${entry.name} uses a compression this app cannot read.`);
  }
  if (total !== entry.size)
    throw new ZipError(`The zip archive is damaged (entry ${entry.name} has the wrong size).`);
  return total;
}

/** Inflates one entry into a single buffer (for small entries like manifest.json). */
export function readEntry(zip: Buffer, entry: ZipEntryInfo, maxBytes: number): Buffer {
  const parts: Uint8Array[] = [];
  inflateEntry(zip, entry, maxBytes, (chunk) => parts.push(chunk));
  return Buffer.concat(parts);
}
