import type { FolderExport, Settings, Stats } from "@organizer/shared";
import { strFromU8, unzipSync } from "fflate";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeFileAtomically } from "../src/services/folder-export.ts";
import { json, makeApp } from "./helpers.ts";

describe("GET /settings", () => {
  it("shows the fixed export folder and data dir to the session only", async () => {
    const t = await makeApp();
    const settings = json<Settings>(await t.call("GET", "/api/v1/settings"));
    expect(settings).toEqual({
      exportDir: join(t.dataDir, "exports"),
      folderExportKeep: 4,
      dataDir: t.dataDir,
      lastExportAt: null,
      lastFolderExport: null,
      version: "0.1.0",
    });
    expect(statSync(settings.exportDir).mode & 0o777).toBe(0o700);
    expect((await t.withToken(t.token("w", "write"), "GET", "/api/v1/settings")).statusCode).toBe(403);
    expect((await t.withToken(t.token("r", "read"), "GET", "/api/v1/settings")).statusCode).toBe(403);
  });
});

describe("POST /export/folder", () => {
  it("writes a private zip atomically and records it", async () => {
    const t = await makeApp();
    await t.create("/api/v1/todos", { title: "Backup me" });
    const res = await t.call("POST", "/api/v1/export/folder");
    expect(res.statusCode).toBe(201);
    const written = res.json() as FolderExport;
    expect(written).toEqual({
      at: "2026-11-11T10:00:00.000Z",
      path: join(t.dataDir, "exports", "organizer-export-20261111-110000.zip"),
      fileName: "organizer-export-20261111-110000.zip",
      bytes: statSync(written.path).size,
    });
    expect(statSync(written.path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(t.dataDir, "exports"))).toEqual([written.fileName]);
    const data = JSON.parse(strFromU8(unzipSync(readFileSync(written.path))["data.json"] as Uint8Array));
    expect(data.todos[0].title).toBe("Backup me");
    const settings = json<Settings>(await t.call("GET", "/api/v1/settings"));
    expect(settings.lastFolderExport).toEqual(written);
    expect(settings.lastExportAt).toBe("2026-11-11T10:00:00.000Z");
    expect(json<Stats>(await t.call("GET", "/api/v1/stats")).lastExportAt).toBe("2026-11-11T10:00:00.000Z");
  });

  it("keeps only the newest 4 zips and gives same-second exports their own name", async () => {
    const t = await makeApp();
    const names: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one export after the other
      names.push(json<FolderExport>(await t.call("POST", "/api/v1/export/folder")).fileName);
      t.advance(1000);
    }
    const same = json<FolderExport>(await t.call("POST", "/api/v1/export/folder"));
    t.setNow("2026-11-11T10:00:06.000Z");
    const twice = json<FolderExport>(await t.call("POST", "/api/v1/export/folder"));
    expect(same.fileName).toBe("organizer-export-20261111-110006.zip");
    expect(twice.fileName).toBe("organizer-export-20261111-110006-2.zip");
    const listed = json<FolderExport[]>(await t.call("GET", "/api/v1/export/folder"));
    expect(listed.map((f) => f.fileName)).toEqual([
      "organizer-export-20261111-110006-2.zip",
      "organizer-export-20261111-110006.zip",
      names[5],
      names[4],
    ]);
    expect(readdirSync(join(t.dataDir, "exports")).toSorted()).toEqual(
      listed.map((f) => f.fileName).toSorted(),
    );
    expect(existsSync(join(t.dataDir, "exports", names[0] as string))).toBe(false);
  });

  it("is allowed for write tokens, not for read tokens", async () => {
    const t = await makeApp();
    expect((await t.withToken(t.token("r", "read"), "POST", "/api/v1/export/folder")).statusCode).toBe(403);
    expect((await t.withToken(t.token("w", "write"), "POST", "/api/v1/export/folder")).statusCode).toBe(201);
    expect((await t.withToken(t.token("r2", "read"), "GET", "/api/v1/export/folder")).statusCode).toBe(200);
  });
});

describe("writeFileAtomically", () => {
  it("leaves neither the file nor a partial file when the stream fails", async () => {
    const t = await makeApp();
    const target = join(t.dataDir, "broken.zip");
    const failing = new Readable({
      read() {
        this.push(Buffer.from("half"));
        this.destroy(new Error("disk gone"));
      },
    });
    await expect(writeFileAtomically(failing, target)).rejects.toThrow("disk gone");
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.partial`)).toBe(false);
  });
});
