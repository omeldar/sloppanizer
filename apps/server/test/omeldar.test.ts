import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accounts, sessions } from "../src/db/auth-schema.ts";
import type { OmeldarClient } from "../src/services/auth/omeldar.ts";
import { AuthError, type User } from "../src/services/auth/omeldar-auth.ts";
import { json, makeApp } from "./helpers.ts";

/**
 * auth.omeldar.com stands in as a fake client: each code names a person; the state must match the
 * pending sign-in like the real client checks. Logout tokens are "sub" or "sub:sid".
 */
function fakeOmeldar(people: Record<string, Partial<User>>, nowS: () => number) {
  const client: OmeldarClient = {
    async callback(callback, pending) {
      const q = callback instanceof URLSearchParams ? callback : new URLSearchParams(String(callback));
      if (q.get("state") !== pending.state) throw new AuthError("state_mismatch", "Not this browser.");
      if (q.get("error")) throw new AuthError(q.get("error") as string, "Cancelled.");
      const person = people[q.get("code") ?? ""];
      if (!person) throw new AuthError("invalid_grant", "Unknown code.");
      const user = {
        iss: "https://auth.example.test",
        aud: "sloppanizer",
        exp: nowS() + 600,
        iat: nowS(),
        auth_time: nowS(),
        sid: "sid-1",
        amr: ["pwd", "otp"],
        acr: "mfa",
        app_role: "user",
        ...person,
      } as User;
      return { user, tokens: {} as never };
    },
    async verifyLogoutToken(token) {
      if (token === "bad") throw new AuthError("invalid_token", "Bad signature.");
      const [sub, sid] = token.split(":");
      return sid ? { sub: sub as string, sid } : { sub: sub as string };
    },
  };
  return client;
}

const pending = { state: "state-123456", nonce: "nonce-123456", verifier: "v".repeat(43) };
const callbackBody = (code: string, extra: Record<string, unknown> = {}) => ({
  query: `?code=${code}&state=${pending.state}`,
  pending,
  timeZone: "Europe/Zurich",
  ...extra,
});

async function omeldarApp(mode: "both" | "oidc", people: Record<string, Partial<User>>) {
  let nowS = 0;
  const t = await makeApp({
    env: { SLOPPANIZER_AUTH: mode, SLOPPANIZER_AUTH_ISSUER: "https://auth.example.test" },
    omeldar: fakeOmeldar(people, () => nowS),
  });
  nowS = Math.floor(t.deps.clock().getTime() / 1000);
  const post = (url: string, body: unknown) =>
    t.app.inject({ method: "POST", url, payload: body as Record<string, unknown> });
  return { t, post };
}

describe("sign in with omeldar", () => {
  it("binds the imported account by legacy_id, then finds it by sub; data and id stay", async () => {
    const { t, post } = await omeldarApp("both", {
      annaCode: { sub: "usr_anna", preferred_username: "anna", name: "Anna Berg", legacy_id: "1" },
    });
    const todo = await t.create<{ id: number }>("/api/v1/todos", { title: "Old data" });

    const first = await post("/api/v1/auth/omeldar/callback", callbackBody("annaCode"));
    expect(first.statusCode).toBe(200);
    const tokens = first.json<{ account: { id: number; username: string; displayName: string } }>();
    expect(tokens.account).toMatchObject({ id: t.account.id, username: "anna", displayName: "Anna Berg" });
    const row = t.deps.db.select().from(accounts).where(eq(accounts.id, t.account.id)).get();
    expect(row?.authSubject).toBe("usr_anna");

    const second = await post("/api/v1/auth/omeldar/callback", callbackBody("annaCode"));
    expect(second.json<{ account: { id: number } }>().account.id).toBe(t.account.id);
    const access = second.json<{ accessToken: string }>().accessToken;
    const mine = await t.app.inject({
      method: "GET",
      url: `/api/v1/todos/${todo.id}`,
      headers: { authorization: `Bearer ${access}` },
    });
    expect(mine.statusCode).toBe(200);
    expect(
      t.deps.db
        .select()
        .from(accounts)
        .all()
        .filter((a) => a.kind === "user"),
    ).toHaveLength(1);
  });

  it("makes a new, seeded account for a new person, with a free username and the role from auth", async () => {
    const { t, post } = await omeldarApp("oidc", {
      newCode: { sub: "usr_new", preferred_username: "anna", name: "Other Anna", app_role: "admin" },
    });
    const res = await post("/api/v1/auth/omeldar/callback", callbackBody("newCode"));
    expect(res.statusCode).toBe(200);
    const account = res.json<{ account: { id: number; username: string; role: string } }>().account;
    // "anna" is taken by an account that is not this person: never matched by username.
    expect(account.id).not.toBe(t.account.id);
    expect(account).toMatchObject({ username: "anna-2", role: "admin" });
    const row = t.deps.db.select().from(accounts).where(eq(accounts.id, account.id)).get();
    expect(row).toMatchObject({ status: "active", timeZone: "Europe/Zurich", authSubject: "usr_new" });
  });

  it("does not bind a legacy account twice, refuses tampered or cancelled sign-ins, keeps disabled accounts out", async () => {
    const { t, post } = await omeldarApp("both", {
      a: { sub: "usr_a", preferred_username: "anna", legacy_id: "1" },
      b: { sub: "usr_b", preferred_username: "anna", legacy_id: "1" },
    });
    expect((await post("/api/v1/auth/omeldar/callback", callbackBody("a"))).statusCode).toBe(200);
    const other = await post("/api/v1/auth/omeldar/callback", callbackBody("b"));
    expect(other.json<{ account: { id: number } }>().account.id).not.toBe(t.account.id);

    const tampered = await post("/api/v1/auth/omeldar/callback", {
      ...callbackBody("a"),
      query: "?code=a&state=forged",
    });
    expect(tampered.statusCode).toBe(401);
    const cancelled = await post("/api/v1/auth/omeldar/callback", {
      ...callbackBody("a"),
      query: `?error=access_denied&state=${pending.state}`,
    });
    expect(cancelled.statusCode).toBe(401);
    expect(json<{ error: { message: string } }>(cancelled).error.message).toBe("Sign-in was cancelled.");

    t.deps.db.update(accounts).set({ status: "disabled" }).where(eq(accounts.id, t.account.id)).run();
    expect((await post("/api/v1/auth/omeldar/callback", callbackBody("a"))).statusCode).toBe(403);
  });

  it("ends the session of a back-channel logout, by sid or all of the person's", async () => {
    const { t, post } = await omeldarApp("both", {
      a: { sub: "usr_a", preferred_username: "anna", legacy_id: "1", sid: "sid-a" },
    });
    await post("/api/v1/auth/omeldar/callback", callbackBody("a"));
    const live = () =>
      t.deps.db
        .select()
        .from(sessions)
        .where(eq(sessions.accountId, t.account.id))
        .all()
        .filter((s) => s.revokedAt === null).length;
    const before = live();
    const logout = (token: string) =>
      t.app.inject({
        method: "POST",
        url: "/api/v1/auth/backchannel-logout",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `logout_token=${encodeURIComponent(token)}`,
      });
    expect((await logout("bad")).statusCode).toBe(422);
    expect((await logout("usr_a:sid-a")).statusCode).toBe(200);
    expect(live()).toBe(before - 1);
    expect((await logout("usr_a")).statusCode).toBe(200);
    expect(live()).toBe(0);
  });

  it("turns the own login and credential changes off in oidc mode, and says so in the config", async () => {
    const { t } = await omeldarApp("oidc", {});
    const config = json<{ mode: string; omeldar: { issuer: string; redirectUri: string } }>(
      await t.app.inject({ method: "GET", url: "/api/v1/auth/config" }),
    );
    expect(config).toMatchObject({
      mode: "oidc",
      signupsOpen: false,
      setupNeeded: false,
      omeldar: { issuer: "https://auth.example.test", clientId: "sloppanizer" },
    });
    const login = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "anna", password: "x".repeat(12), code: "123456" },
    });
    expect(login.statusCode).toBe(410);
    expect((await t.call("POST", "/api/v1/account/recovery-codes")).statusCode).toBe(410);
    // Everything else keeps working with the existing session.
    expect((await t.call("GET", "/api/v1/todos")).statusCode).toBe(200);
  });

  it("confirms it is you with a fresh sign-in of the same person only", async () => {
    const { t, post } = await omeldarApp("both", {
      a: { sub: "usr_a", preferred_username: "anna", legacy_id: "1" },
      other: { sub: "usr_other", preferred_username: "zed" },
    });
    const tokens = (await post("/api/v1/auth/omeldar/callback", callbackBody("a"))).json<{
      accessToken: string;
    }>();
    const reauth = (code: string) =>
      t.app.inject({
        method: "POST",
        url: "/api/v1/auth/omeldar/reauth",
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        payload: { query: `?code=${code}&state=${pending.state}`, pending },
      });
    expect((await reauth("other")).statusCode).toBe(403);
    expect((await reauth("a")).statusCode).toBe(204);
  });
});
