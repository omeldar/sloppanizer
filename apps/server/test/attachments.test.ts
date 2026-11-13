import type { Attachment } from "@organizer/shared";
import { createHash } from "node:crypto";
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sanitizeName } from "../src/services/attachments.ts";
import { makeApp, type TestApp } from "./helpers.ts";

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([36, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);
const PDF = Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const HTML = Buffer.from("<!doctype html><script>alert(document.cookie)</script>");

function upload(
  t: TestApp,
  bytes: Buffer,
  name?: string,
  contentType = "application/octet-stream",
  token?: string,
) {
  const query = name === undefined ? "" : `?name=${encodeURIComponent(name)}`;
  return t.app.inject({
    method: "POST",
    url: `/api/v1/attachments${query}`,
    headers: {
      "content-type": contentType,
      ...(token ? { authorization: `Bearer ${token}` } : t.account.headers()),
    },
    payload: bytes,
  });
}

async function stored(t: TestApp, bytes: Buffer, name?: string, contentType?: string): Promise<Attachment> {
  const res = await upload(t, bytes, name, contentType);
  if (res.statusCode !== 201) throw new Error(`upload -> ${res.statusCode}: ${res.body}`);
  return res.json() as Attachment;
}

describe("attachment uploads", () => {
  it("stores the file under its id, private, and returns its details", async () => {
    const t = await makeApp();
    const a = await stored(t, PNG, "Screen Shot.png");
    expect(a).toEqual({
      id: 1,
      name: "Screen-Shot.png",
      mimeType: "image/png",
      size: PNG.length,
      sha256: createHash("sha256").update(PNG).digest("hex"),
      url: "/api/v1/attachments/1/Screen-Shot.png",
      inline: true,
      createdBy: "you",
      createdAt: "2026-11-11T10:00:00.000Z",
    });
    expect(readdirSync(t.filesDir)).toEqual(["1"]);
    expect(statSync(join(t.filesDir, "1")).mode & 0o777).toBe(0o600);
    expect((await t.call("GET", "/api/v1/attachments/1/meta")).json()).toEqual(a);
  });

  it("decides the type by magic bytes only", async () => {
    const t = await makeApp();
    const cases: [Buffer, string, boolean][] = [
      [PNG, "image/png", true],
      [JPEG, "image/jpeg", true],
      [GIF, "image/gif", true],
      [WEBP, "image/webp", true],
      [PDF, "application/pdf", false],
      [SVG, "application/octet-stream", false],
      [HTML, "application/octet-stream", false],
      [Buffer.from("PK\x03\x04zip", "latin1"), "application/octet-stream", false],
      [Buffer.from("plain text"), "application/octet-stream", false],
    ];
    const results = await Promise.all(cases.map(([bytes]) => stored(t, bytes)));
    expect(results.map((a) => [a.mimeType, a.inline])).toEqual(
      cases.map(([, mime, inline]) => [mime, inline]),
    );
    // A spoofed Content-Type changes nothing, in either direction.
    expect((await stored(t, HTML, "x.png", "image/png")).mimeType).toBe("application/octet-stream");
    expect((await stored(t, PNG, "x.html", "text/html")).mimeType).toBe("image/png");
    // No Content-Type at all works too (fetch with a plain ArrayBuffer body).
    const bare = await t.app.inject({
      method: "POST",
      url: "/api/v1/attachments?name=bare.png",
      headers: t.account.headers(),
      payload: PNG,
    });
    expect(bare.statusCode).toBe(201);
    expect(bare.json().mimeType).toBe("image/png");
    // A JSON body is stored as bytes, not parsed.
    const json = await stored(t, Buffer.from('{"title":"x"}'), "data.json", "application/json");
    expect(json).toMatchObject({ mimeType: "application/octet-stream", size: 13 });
  });

  it("gives default names with the extension of the type", async () => {
    const t = await makeApp();
    expect((await stored(t, PNG)).name).toBe("file.png");
    expect((await stored(t, JPEG, "")).name).toBe("file.jpg");
    expect((await stored(t, Buffer.from("x"))).name).toBe("file");
  });

  it("answers 422 for an empty body and 413 over 25 MiB", async () => {
    const t = await makeApp();
    const empty = await upload(t, Buffer.alloc(0), "x.png");
    expect(empty.statusCode).toBe(422);
    const big = await upload(t, Buffer.alloc(25 * 1024 * 1024 + 1, 1), "big.bin");
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toEqual({ code: "too_large", message: "Files can be up to 25 MB." });
    // Bigger than the 1 MiB JSON limit is fine here.
    expect((await upload(t, Buffer.alloc(2 * 1024 * 1024, 1), "two-mb.bin")).statusCode).toBe(201);
    expect(readdirSync(t.filesDir)).toEqual(["1"]);
  });

  it("keeps JSON parsing of other routes unchanged", async () => {
    const t = await makeApp();
    const asText = await t.app.inject({
      method: "POST",
      url: "/api/v1/todos",
      headers: { ...t.account.headers(), "content-type": "text/plain" },
      payload: '{"title":"x"}',
    });
    expect(asText.statusCode).toBe(422);
    expect((await t.call("POST", "/api/v1/todos", { title: "x" })).statusCode).toBe(201);
    const big = await t.app.inject({
      method: "POST",
      url: "/api/v1/todos",
      headers: { ...t.account.headers(), "content-type": "application/json" },
      payload: JSON.stringify({ title: "x", descriptionMd: "y".repeat(1_100_000) }),
    });
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe("too_large");
  });

  it("lets read tokens download but not upload; no auth gets 401", async () => {
    const t = await makeApp();
    await stored(t, PNG);
    const reader = t.token("reader", "read");
    const writer = t.token("assistant", "write");
    expect((await t.withToken(reader, "GET", "/api/v1/attachments/1/file.png")).statusCode).toBe(200);
    expect((await upload(t, PNG, "x.png", "image/png", reader)).statusCode).toBe(403);
    const byToken = await upload(t, PNG, "x.png", "image/png", writer);
    expect(byToken.statusCode).toBe(201);
    expect(byToken.json().createdBy).toBe("assistant");
    const anonymous = await t.app.inject({ method: "GET", url: "/api/v1/attachments/1" });
    expect(anonymous.statusCode).toBe(401);
    const anonymousUpload = await t.app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: { "content-type": "image/png" },
      payload: PNG,
    });
    expect(anonymousUpload.statusCode).toBe(401);
  });
});

describe("attachment downloads", () => {
  it("serves images inline and byte-identical, with the file headers", async () => {
    const t = await makeApp();
    const a = await stored(t, PNG, "shot.png");
    const res = await t.call("GET", a.url);
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(PNG)).toBe(true);
    expect(res.headers).toMatchObject({
      "content-type": "image/png",
      "content-length": String(PNG.length),
      "content-disposition": "inline; filename*=UTF-8''shot.png",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
    });
    // The name in the link is ignored.
    expect((await t.call("GET", "/api/v1/attachments/1/other-name.txt")).rawPayload.equals(PNG)).toBe(true);
    expect((await t.call("GET", "/api/v1/attachments/1")).statusCode).toBe(200);
  });

  it("serves svg and html only as sandboxed downloads, never as markup", async () => {
    const t = await makeApp();
    const check = async (bytes: Buffer, name: string, claimed: string) => {
      const a = await stored(t, bytes, name, claimed);
      const res = await t.call("GET", a.url);
      expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["content-disposition"]).toBe(`attachment; filename*=UTF-8''${name}`);
      expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.rawPayload.equals(bytes)).toBe(true);
    };
    await check(SVG, "logo.svg", "image/svg+xml");
    await check(HTML, "page.html", "text/html");
    const pdf = await stored(t, PDF, "report.pdf");
    const res = await t.call("GET", pdf.url);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe("attachment; filename*=UTF-8''report.pdf");
  });

  it("keeps the sandbox policy even for a row whose type says text/html", async () => {
    const t = await makeApp();
    const a = await stored(t, HTML, "page.html", "text/html");
    // As a crafted restore could have left it before the restore cleaned types.
    t.deps.db.$client.prepare("UPDATE attachments SET mime_type = 'text/html' WHERE id = ?").run(a.id);
    const res = await t.call("GET", a.url);
    expect(res.headers["content-type"]).toMatch(/^text\/html/);
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
  });

  it("answers 404 for unknown ids and for a file missing on disk", async () => {
    const t = await makeApp();
    expect((await t.call("GET", "/api/v1/attachments/9")).statusCode).toBe(404);
    expect((await t.call("GET", "/api/v1/attachments/9/meta")).statusCode).toBe(404);
    const a = await stored(t, PNG);
    rmSync(join(t.filesDir, String(a.id)));
    const res = await t.call("GET", a.url);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toBe(
      "The file of attachment 1 is missing from the data folder. Restore it from an export.",
    );
    // The details still exist.
    expect((await t.call("GET", "/api/v1/attachments/1/meta")).statusCode).toBe(200);
  });
});

describe("sanitizeName", () => {
  it("keeps safe characters, drops paths and leading dots, limits the length", () => {
    expect(sanitizeName("Screen Shot 2026-11-12 at 14.03.png", ".png")).toBe(
      "Screen-Shot-2026-11-12-at-14.03.png",
    );
    expect(sanitizeName("../../etc/passwd", "")).toBe("passwd");
    expect(sanitizeName("C:\\Users\\me\\Bericht März.pdf", ".pdf")).toBe("Bericht-M-rz.pdf");
    expect(sanitizeName(".htaccess", "")).toBe("htaccess");
    expect(sanitizeName("..", ".png")).toBe("file.png");
    expect(sanitizeName("---", "")).toBe("file");
    expect(sanitizeName(undefined, ".gif")).toBe("file.gif");
    expect(sanitizeName("meta", "")).toBe("meta-file");
    const long = sanitizeName(`${"a".repeat(150)}.jpeg`, ".jpg");
    expect(long).toHaveLength(100);
    expect(long.endsWith(".jpeg")).toBe(true);
  });
});
