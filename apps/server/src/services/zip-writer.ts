import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { PassThrough, type Readable } from "node:stream";

/** One zip entry: small content in memory, or a file read in chunks. `stored` = no compression. */
export type ZipEntry = { path: string; stored: boolean } & ({ content: Uint8Array } | { file: string });

/**
 * Streams the entries as one zip; files are read in chunks, with backpressure, so a large zip never sits
 * in memory. Errors (a file gone missing) destroy the stream.
 */
export function zipStream(entries: readonly ZipEntry[], mtime: Date): Readable {
  const out = new PassThrough();
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      out.destroy(error);
      return;
    }
    out.write(chunk);
    if (final) out.end();
  });
  const write = async () => {
    for (const entry of entries) {
      const file = entry.stored ? new ZipPassThrough(entry.path) : new ZipDeflate(entry.path, { level: 6 });
      file.mtime = mtime;
      zip.add(file);
      if ("content" in entry) {
        file.push(entry.content, true);
      } else {
        // oxlint-disable-next-line no-await-in-loop -- files are read one after the other
        for await (const chunk of createReadStream(entry.file)) {
          file.push(chunk as Uint8Array);
          // oxlint-disable-next-line no-await-in-loop -- wait for the reader before reading more
          if (out.writableNeedDrain) await once(out, "drain");
        }
        file.push(new Uint8Array(0), true);
      }
      // oxlint-disable-next-line no-await-in-loop -- one entry after the other keeps memory small
      if (out.writableNeedDrain) await once(out, "drain");
    }
    zip.end();
  };
  write().catch((error: unknown) => {
    zip.terminate();
    out.destroy(error as Error);
  });
  return out;
}
