import type { Settings, Stats } from "@organizer/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { VERSION } from "../src/app.ts";
import { describe, expect, it } from "vitest";
import { writeFileAtomically } from "../src/services/files.ts";
import { json, makeApp, type TestApp } from "./helpers.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const upload = (t: TestApp, headers: Record<string, string>, bytes: Buffer) =>
  t.app.inject({
    method: "POST",
    url: "/api/v1/attachments?name=a.png",
    headers: { ...headers, "content-type": "application/octet-stream" },
    payload: bytes,
  });

describe("GET /settings", () => {
  it("shows the account's last export, the version and its files against the limit, to the session only", async () => {
    const t = await makeApp();
    expect(json<Settings>(await t.call("GET", "/api/v1/settings"))).toEqual({
      lastExportAt: null,
      version: VERSION,
      filesBytes: 0,
      filesLimitBytes: 2048 * 1024 * 1024,
    });
    expect((await t.withToken(t.token("w", "write"), "GET", "/api/v1/settings")).statusCode).toBe(403);
    expect((await t.withToken(t.token("r", "read"), "GET", "/api/v1/settings")).statusCode).toBe(403);
  });

  it("counts only the account's own files and export time", async () => {
    const t = await makeApp();
    const bert = await t.asAccount({ username: "bert" });
    expect((await upload(t, t.account.headers(), PNG)).statusCode).toBe(201);
    expect((await upload(t, bert.account.headers(), Buffer.concat([PNG, PNG]))).statusCode).toBe(201);
    t.advance(60_000);
    expect((await bert.call("GET", "/api/v1/export.zip")).statusCode).toBe(200);

    const mine = json<Settings>(await t.call("GET", "/api/v1/settings"));
    expect(mine.filesBytes).toBe(PNG.length);
    expect(mine.lastExportAt).toBeNull();
    expect(json<Stats>(await t.call("GET", "/api/v1/stats")).lastExportAt).toBeNull();
    const theirs = json<Settings>(await bert.call("GET", "/api/v1/settings"));
    expect(theirs.filesBytes).toBe(2 * PNG.length);
    expect(theirs.lastExportAt).toBe("2026-11-11T10:01:00.000Z");
  });
});

describe("write to folder", () => {
  it("is gone: the folder would sit on the server, out of the user's reach", async () => {
    const t = await makeApp();
    expect((await t.call("POST", "/api/v1/export/folder")).statusCode).toBe(404);
    expect((await t.call("GET", "/api/v1/export/folder")).statusCode).toBe(404);
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
