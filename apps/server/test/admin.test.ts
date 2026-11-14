import { and, eq } from "drizzle-orm";
import type { InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { accounts, adminEvents } from "../src/db/auth-schema.ts";
import { labels, todos } from "../src/db/schema.ts";
import { REAUTH_WINDOW_MS } from "../src/http/security.ts";
import { unknownRouteBody } from "../src/http/web.ts";
import { fillEveryTable } from "./fixtures.ts";
import { makeApp } from "./helpers.ts";

const A = "/api/v1/admin";

/** An instance with the admin "boss" next to the default (non-admin) account "anna". */
async function withAdmin() {
  const t = await makeApp();
  const boss = await t.asAccount({ username: "boss", role: "admin" });
  const statusOf = (id: number) => t.deps.db.select().from(accounts).where(eq(accounts.id, id)).get()?.status;
  const actions = () =>
    t.deps.db
      .select()
      .from(adminEvents)
      .where(eq(adminEvents.actor, "boss"))
      .all()
      .map((event) => [event.action, event.target]);
  return { t, boss, statusOf, actions };
}

const routes = (id: number): [InjectOptions["method"], string, unknown?][] => [
  ["GET", `${A}/signups`],
  ["POST", `${A}/signups/${id}/approve`],
  ["POST", `${A}/signups/${id}/reject`],
  ["GET", `${A}/accounts`],
  ["POST", `${A}/accounts/${id}/disable`],
  ["POST", `${A}/accounts/${id}/enable`],
  ["POST", `${A}/accounts/${id}/unlock`],
  ["POST", `${A}/accounts/${id}/reset-login`],
  ["DELETE", `${A}/accounts/${id}`, { confirmUsername: "x" }],
  ["GET", `${A}/events`],
  ["GET", `${A}/instance`],
  ["POST", `${A}/backups`],
];

describe("admin routes", () => {
  it("look like unknown routes to non-admins and to every token, the admin's own too", async () => {
    const { t, boss } = await withAdmin();
    const annaToken = t.token("cli", "write");
    const bossToken = boss.token("cli", "write");
    for (const [method, url, body] of routes(t.account.id)) {
      const unknown = unknownRouteBody(method as string, url);
      // oxlint-disable-next-line no-await-in-loop -- some calls change state for the next one
      const asAnna = await t.call(method, url, body);
      expect([url, asAnna.statusCode]).toEqual([url, 404]);
      expect(asAnna.json()).toEqual(unknown);
      for (const raw of [annaToken, bossToken]) {
        // oxlint-disable-next-line no-await-in-loop -- see above
        const viaToken = await t.withToken(raw, method, url, body);
        expect([url, viaToken.statusCode]).toEqual([url, 404]);
        expect(viaToken.json()).toEqual(unknown);
      }
    }
    expect(t.deps.db.select().from(accounts).where(eq(accounts.username, "anna")).get()?.status).toBe(
      "active",
    );
  });

  it("need a fresh sign-in for changes, not for reading", async () => {
    const { t, boss } = await withAdmin();
    boss.account.reauthenticate();
    t.advance(REAUTH_WINDOW_MS + 1000);
    const stale = (method: InjectOptions["method"], url: string) =>
      t.app.inject({ method, url, headers: boss.account.headers() });
    expect((await stale("GET", `${A}/accounts`)).statusCode).toBe(200);
    const change = await stale("POST", `${A}/accounts/${t.account.id}/disable`);
    expect(change.statusCode).toBe(403);
    expect(change.json().error.code).toBe("reauth_required");
  });

  it("approve seeds the account, reject deletes the sign-up; both are logged", async () => {
    const { t, boss, statusOf, actions } = await withAdmin();
    const petra = await t.asAccount({ username: "petra", status: "pending" });
    const olaf = await t.asAccount({ username: "olaf", status: "pending" });
    const signups = await boss.call("GET", `${A}/signups`);
    expect(
      signups
        .json()
        .map((s: { username: string }) => s.username)
        .toSorted(),
    ).toEqual(["olaf", "petra"]);

    const labelsOf = (id: number) =>
      t.deps.db.select().from(labels).where(eq(labels.accountId, id)).all().length;
    expect(labelsOf(petra.account.id)).toBe(0);
    const approved = await boss.call("POST", `${A}/signups/${petra.account.id}/approve`);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ username: "petra", status: "active" });
    expect(labelsOf(petra.account.id)).toBe(labelsOf(t.account.id));
    // Approving twice, or rejecting an active account, is a 404 (it is no sign-up any more).
    expect((await boss.call("POST", `${A}/signups/${petra.account.id}/approve`)).statusCode).toBe(404);
    expect((await boss.call("POST", `${A}/signups/${petra.account.id}/reject`)).statusCode).toBe(404);

    expect((await boss.call("POST", `${A}/signups/${olaf.account.id}/reject`)).statusCode).toBe(204);
    expect(statusOf(olaf.account.id)).toBeUndefined();
    expect(actions()).toEqual([
      ["approve", "petra"],
      ["reject", "olaf"],
    ]);
  });

  it("disable signs the account out; enable lets it in again; delete only takes a disabled account", async () => {
    const { t, boss, statusOf, actions } = await withAdmin();
    await t.create("/api/v1/todos", { title: "Water the plants" });
    const id = t.account.id;

    expect((await boss.call("DELETE", `${A}/accounts/${id}`, { confirmUsername: "anna" })).statusCode).toBe(
      409,
    );

    const disabled = await boss.call("POST", `${A}/accounts/${id}/disable`);
    expect(disabled.json()).toMatchObject({ status: "disabled" });
    expect(t.account.session()?.revokedAt).not.toBeNull();
    expect((await t.call("GET", "/api/v1/todos")).statusCode).toBe(401);

    expect((await boss.call("POST", `${A}/accounts/${id}/enable`)).json()).toMatchObject({
      status: "active",
    });
    expect((await boss.call("POST", `${A}/accounts/${id}/disable`)).statusCode).toBe(200);

    const wrongName = await boss.call("DELETE", `${A}/accounts/${id}`, { confirmUsername: "annie" });
    expect(wrongName.statusCode).toBe(422);
    expect(statusOf(id)).toBe("disabled");

    expect((await boss.call("DELETE", `${A}/accounts/${id}`, { confirmUsername: "anna" })).statusCode).toBe(
      204,
    );
    expect(statusOf(id)).toBeUndefined();
    expect(t.deps.db.select().from(todos).where(eq(todos.accountId, id)).all()).toEqual([]);
    expect(actions()).toEqual([
      ["disable", "anna"],
      ["enable", "anna"],
      ["disable", "anna"],
      ["delete", "anna"],
    ]);
  });

  it("refuses every action on the admin's own account", async () => {
    const { t, boss, statusOf } = await withAdmin();
    for (const [method, url, body] of routes(boss.account.id).filter(([, path]) =>
      path.includes("/accounts/"),
    )) {
      // oxlint-disable-next-line no-await-in-loop -- each refusal must leave the account as it was
      const res = await boss.call(method, url, method === "DELETE" ? { confirmUsername: "boss" } : body);
      expect([url, res.statusCode]).toEqual([url, 409]);
    }
    expect(statusOf(boss.account.id)).toBe("active");
    expect(t.deps.db.select().from(adminEvents).where(eq(adminEvents.actor, "boss")).all()).toEqual([]);
  });

  it("unlock and reset-login are logged; the reset code is shown once", async () => {
    const { t, boss, actions } = await withAdmin();
    expect((await boss.call("POST", `${A}/accounts/${t.account.id}/unlock`)).statusCode).toBe(200);
    const reset = await boss.call("POST", `${A}/accounts/${t.account.id}/reset-login`);
    expect(reset.json()).toEqual({ resetCode: expect.any(String), expiresAt: "2026-11-12T10:00:00.000Z" });
    const row = t.deps.db.select().from(accounts).where(eq(accounts.id, t.account.id)).get();
    expect(JSON.stringify(row)).not.toContain(reset.json().resetCode);
    expect(actions()).toEqual([
      ["unlock", "anna"],
      ["reset_login", "anna"],
    ]);
  });

  it("show metadata only, never account contents", async () => {
    const { t, boss } = await withAdmin();
    await fillEveryTable(t);
    expect((await boss.call("POST", `${A}/backups`)).statusCode).toBe(201);
    const answers = await Promise.all(
      routes(t.account.id)
        .filter(([method]) => method === "GET")
        .map(async ([method, url]) => (await boss.call(method, url)).body),
    );
    const text = answers.join("\n");
    expect(text).toContain("anna");
    for (const content of [
      "Rack",
      "Lab",
      "homelab",
      "Müller",
      "shot.png",
      "Prefers chat",
      "dns",
      "fast reply",
    ]) {
      expect(text).not.toContain(content);
    }
  });

  it("instance info counts accounts and lists backups made from the dashboard", async () => {
    const { t, boss } = await withAdmin();
    await t.asAccount({ username: "petra", status: "pending" });
    const before = (await boss.call("GET", `${A}/instance`)).json();
    expect(before).toMatchObject({
      accounts: { pending: 1, active: 2, disabled: 0 },
      backups: { lastAt: null, nextAt: "2026-11-12T03:30:00.000Z", files: [] },
    });
    expect(before.dbBytes).toBeGreaterThan(0);

    const backup = await boss.call("POST", `${A}/backups`);
    expect(backup.statusCode).toBe(201);
    const after = (await boss.call("GET", `${A}/instance`)).json();
    // The listing reads the file's mtime (real time), the answer the server clock: compare name and size.
    const { fileName, bytes } = backup.json();
    expect(after.backups.files).toEqual([{ fileName, bytes, createdAt: expect.any(String) }]);
    expect(after.backups.lastAt).not.toBeNull();
    const logged = t.deps.db
      .select()
      .from(adminEvents)
      .where(and(eq(adminEvents.actor, "boss"), eq(adminEvents.action, "backup")))
      .all();
    expect(logged).toHaveLength(1);
  });
});
