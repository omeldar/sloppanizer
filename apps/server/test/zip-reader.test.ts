import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { inflateEntry, readCentralDirectory, ZipError } from "../src/services/zip-reader.ts";

const MiB = 1024 * 1024;

/** A zip with one deflated entry of `bytes` zeros whose directory claims `declared` bytes. */
function lyingZip(bytes: number, declared: number): Buffer {
  const zip = Buffer.from(zipSync({ "bomb.bin": new Uint8Array(bytes) }, { level: 1 }));
  const central = zip.lastIndexOf(Buffer.from("bomb.bin")) - 46;
  expect(zip.readUInt32LE(central)).toBe(0x02014b50);
  zip.writeUInt32LE(declared, central + 24);
  return zip;
}

describe("inflateEntry", () => {
  it("stops a zip bomb at its declared size, whatever limit the caller passes", () => {
    const zip = lyingZip(4 * MiB, 10);
    const [entry] = readCentralDirectory(zip);
    let handed = 0;
    expect(() =>
      inflateEntry(zip, entry!, 4096 * MiB, (chunk) => {
        handed += chunk.length;
      }),
    ).toThrow(ZipError);
    // Nothing past the declared size reaches the caller.
    expect(handed).toBeLessThanOrEqual(10);
  });

  it("refuses an entry that declares more than the limit before unpacking anything", () => {
    const zip = lyingZip(1000, 1000);
    const [entry] = readCentralDirectory(zip);
    let called = false;
    expect(() =>
      inflateEntry(zip, entry!, 999, () => {
        called = true;
      }),
    ).toThrow(/larger than allowed/);
    expect(called).toBe(false);
  });

  it("refuses an entry that is shorter than declared, and reads an honest one", () => {
    const short = lyingZip(1000, 2000);
    expect(() => inflateEntry(short, readCentralDirectory(short)[0]!, 4000, () => {})).toThrow(/wrong size/);
    const honest = lyingZip(MiB, MiB);
    expect(inflateEntry(honest, readCentralDirectory(honest)[0]!, MiB, () => {})).toBe(MiB);
  });
});
