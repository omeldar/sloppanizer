import {
  type CreatedDrawHandoff,
  DRAW_TOKEN_HEADER,
  type DrawHandoff,
  type DrawingList,
  type Space,
} from "@organizer/shared";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { drawHandoffs } from "../src/db/auth-schema.ts";
import { CORS_ALLOW_HEADERS } from "../src/http/cors.ts";
import { accountFilesDir } from "../src/services/attachments.ts";
import { drawingName } from "../src/services/drawings.ts";
import { json, makeApp, type TestApp } from "./helpers.ts";

const H = "x-sloppanizer-space";
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2, 3,
]);
const MINUTE = 60_000;

/** The phone: no session, only the token header. */
const phone = (t: TestApp, method: "GET" | "POST", token: string | null, body?: Buffer) =>
  t.app.inject({
    method,
    url: "/api/v1/draw-handoff",
    headers: {
      ...(token === null ? {} : { [DRAW_TOKEN_HEADER]: token }),
      ...(body ? { "content-type": "image/png" } : {}),
    },
    ...(body ? { payload: body } : {}),
  });

const open = async (call: TestApp["call"], headers: Record<string, string> = {}) => {
  const res = await call("POST", "/api/v1/drawings/handoffs", undefined, headers);
  expect(res.statusCode).toBe(201);
  return json<CreatedDrawHandoff>(res);
};

const poll = (t: TestApp, id: number, headers: Record<string, string> = {}) =>
  t.call("GET", `/api/v1/drawings/handoffs/${id}`, undefined, headers);

describe("draw on your phone", () => {
  it("hands over exactly one drawing, then the link stops working", async () => {
    const t = await makeApp();
    const handoff = await open(t.call);
    expect(handoff.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(handoff.expiresAt).toBe("2026-11-11T10:10:00.000Z");
    // Only the hash is stored.
    const row = t.deps.db.select().from(drawHandoffs).where(eq(drawHandoffs.id, handoff.id)).get();
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.tokenHash).not.toContain(handoff.token);

    expect(json(await phone(t, "GET", handoff.token))).toEqual({ expiresAt: handoff.expiresAt });
    expect(json<DrawHandoff>(await poll(t, handoff.id))).toEqual({
      id: handoff.id,
      status: "waiting",
      expiresAt: handoff.expiresAt,
      attachment: null,
    });

    t.advance(MINUTE);
    expect((await phone(t, "POST", handoff.token, PNG)).statusCode).toBe(204);
    const done = json<DrawHandoff>(await poll(t, handoff.id));
    expect(done.status).toBe("received");
    expect(done.attachment).toMatchObject({
      name: "drawing-2026-11-11-1101.png",
      mimeType: "image/png",
      size: PNG.length,
      createdBy: "you",
      inline: true,
    });
    const id = done.attachment?.id as number;
    expect(readFileSync(join(t.filesDir, String(id)))).toEqual(PNG);

    // Single use: the token is cleared, both phone calls now fail the same way.
    expect(
      t.deps.db.select().from(drawHandoffs).where(eq(drawHandoffs.id, handoff.id)).get()?.tokenHash,
    ).toBe(null);
    const again = await phone(t, "POST", handoff.token, PNG);
    expect(again.statusCode).toBe(404);
    expect(json<{ error: { message: string } }>(again).error.message).toContain(
      "expired or was already used",
    );
    expect((await phone(t, "GET", handoff.token)).statusCode).toBe(404);

    // The drawing is in the recent drawings, other files are not.
    await t.app.inject({
      method: "POST",
      url: "/api/v1/attachments?name=photo.png",
      headers: { ...t.account.headers(), "content-type": "image/png" },
      payload: PNG,
    });
    const recent = json<DrawingList>(await t.call("GET", "/api/v1/drawings"));
    expect(recent.items.map((a) => a.id)).toEqual([id]);
  });

  it("expires after 10 minutes, then is pruned", async () => {
    const t = await makeApp();
    const handoff = await open(t.call);
    t.advance(10 * MINUTE);
    expect((await phone(t, "GET", handoff.token)).statusCode).toBe(404);
    expect((await phone(t, "POST", handoff.token, PNG)).statusCode).toBe(404);
    expect(json<DrawHandoff>(await poll(t, handoff.id)).status).toBe("expired");
    expect(t.deps.db.select().from(drawHandoffs).get()?.tokenHash).toBe(null);
    t.advance(61 * MINUTE);
    expect((await poll(t, handoff.id)).statusCode).toBe(404);
    expect(t.deps.db.select().from(drawHandoffs).all()).toEqual([]);
  });

  it("refuses a missing, malformed or unknown token and anything but a PNG", async () => {
    const t = await makeApp();
    const handoff = await open(t.call);
    expect((await phone(t, "GET", null)).statusCode).toBe(404);
    expect((await phone(t, "GET", "short")).statusCode).toBe(404);
    expect((await phone(t, "GET", "a".repeat(43))).statusCode).toBe(404);
    expect((await phone(t, "POST", null, PNG)).statusCode).toBe(404);
    const html = await phone(t, "POST", handoff.token, Buffer.from("<!doctype html><script>x</script>"));
    expect(html.statusCode).toBe(415);
    // A refused file does not use up the link.
    expect((await phone(t, "POST", handoff.token, PNG)).statusCode).toBe(204);
  });

  it("belongs to the user who opened it: other accounts and API tokens cannot see or make one", async () => {
    const t = await makeApp();
    const bob = await t.asAccount({ username: "bobo" });
    const handoff = await open(t.call);
    expect((await bob.call("GET", `/api/v1/drawings/handoffs/${handoff.id}`)).statusCode).toBe(404);
    expect((await bob.call("DELETE", `/api/v1/drawings/handoffs/${handoff.id}`)).statusCode).toBe(404);
    const token = t.token("script", "write");
    expect((await t.withToken(token, "POST", "/api/v1/drawings/handoffs")).statusCode).toBe(403);
    // Bob's own link stores into Bob's files only.
    const own = await open(bob.call);
    expect((await phone(t, "POST", own.token, PNG)).statusCode).toBe(204);
    expect(json<DrawingList>(await t.call("GET", "/api/v1/drawings")).items).toEqual([]);
    expect(json<DrawingList>(await bob.call("GET", "/api/v1/drawings")).items).toHaveLength(1);
  });

  it("stops at once when the computer ends it", async () => {
    const t = await makeApp();
    const handoff = await open(t.call);
    expect((await t.call("DELETE", `/api/v1/drawings/handoffs/${handoff.id}`)).statusCode).toBe(204);
    expect((await phone(t, "POST", handoff.token, PNG)).statusCode).toBe(404);
    expect((await poll(t, handoff.id)).statusCode).toBe(404);
  });

  it("counts against the account's file limit", async () => {
    const t = await makeApp({ env: { SLOPPANIZER_FILES_LIMIT_MB: "1" } });
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024 - PNG.length - 4)]);
    const first = await t.app.inject({
      method: "POST",
      url: "/api/v1/attachments?name=big.png",
      headers: { ...t.account.headers(), "content-type": "image/png" },
      payload: big,
    });
    expect(first.statusCode).toBe(201);
    const handoff = await open(t.call);
    const res = await phone(t, "POST", handoff.token, PNG);
    expect(res.statusCode).toBe(413);
    expect(json(await poll(t, handoff.id))).toMatchObject({ status: "waiting" });
  });

  it("limits how many links a user makes", async () => {
    const t = await makeApp();
    // In parallel: the server handles them one at a time anyway.
    await Promise.all(Array.from({ length: 10 }, () => open(t.call)));
    const res = await t.call("POST", "/api/v1/drawings/handoffs");
    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    t.advance(10 * MINUTE);
    await open(t.call);
  });

  it("stores into the shared project it was opened in, for members only", async () => {
    const t = await makeApp();
    const bob = await t.asAccount({ username: "bobo" });
    const space = await t.create<Space>("/api/v1/spaces", { name: "Extranet", members: ["bobo"] });
    const inSpace = { [H]: String(space.id) };
    const handoff = await open(t.call, inSpace);
    // Not visible from the own account, nor to another member.
    expect((await poll(t, handoff.id)).statusCode).toBe(404);
    expect(
      (await bob.call("GET", `/api/v1/drawings/handoffs/${handoff.id}`, undefined, inSpace)).statusCode,
    ).toBe(404);
    expect((await phone(t, "POST", handoff.token, PNG)).statusCode).toBe(204);
    const done = json<DrawHandoff>(await poll(t, handoff.id, inSpace));
    expect(done.attachment?.createdBy).toBe("anna");
    const id = done.attachment?.id as number;
    expect(readFileSync(join(accountFilesDir(t.deps.filesDir, space.id), String(id)))).toEqual(PNG);
    expect(
      json<DrawingList>(await bob.call("GET", "/api/v1/drawings", undefined, inSpace)).items,
    ).toHaveLength(1);
    expect(json<DrawingList>(await t.call("GET", "/api/v1/drawings")).items).toEqual([]);

    // A member who leaves cannot send into it with a link made before.
    const later = await open(bob.call, inSpace);
    expect((await t.call("DELETE", `/api/v1/spaces/${space.id}/members/${bob.account.id}`)).statusCode).toBe(
      204,
    );
    expect((await phone(t, "POST", later.token, PNG)).statusCode).toBe(404);
  });

  it("never writes the token to the log", async () => {
    const logs: string[] = [];
    const t = await makeApp({ logs });
    const handoff = await open(t.call);
    await phone(t, "GET", handoff.token);
    await phone(t, "POST", handoff.token, PNG);
    await phone(t, "POST", handoff.token, PNG);
    await poll(t, handoff.id);
    const text = logs.join("\n");
    expect(text).toContain("/api/v1/draw-handoff");
    expect(text).not.toContain(handoff.token);
    expect(CORS_ALLOW_HEADERS).toContain(DRAW_TOKEN_HEADER);
  });

  it("names drawings by the minute in the user's time zone", () => {
    expect(drawingName(new Date("2026-11-27T23:05:00.000Z"), "Europe/Zurich")).toBe(
      "drawing-2026-11-28-0005.png",
    );
  });
});
