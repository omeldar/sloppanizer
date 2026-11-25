import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accounts, adminEvents, sessions } from "../src/db/auth-schema.ts";
import type { OmeldarClient } from "../src/services/auth/omeldar.ts";
import { AuthError, type User } from "../src/services/auth/omeldar-auth.ts";
import { codeAt, TEST_PASSWORD, TEST_TOTP_SECRET } from "./auth-helpers.ts";
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

async function omeldarApp(
  mode: "local" | "both" | "oidc",
  people: Record<string, Partial<User>>,
  env: Record<string, string> = {},
) {
  let nowS = 0;
  const t = await makeApp({
    env: { SLOPPANIZER_AUTH: mode, SLOPPANIZER_AUTH_ISSUER: "https://auth.example.test", ...env },
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

/** Anna's own login (password and authenticator) at the test clock's now. */
const passwordLogin = (t: Awaited<ReturnType<typeof omeldarApp>>["t"]) =>
  t.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { username: "anna", password: TEST_PASSWORD, code: codeAt(TEST_TOTP_SECRET, t.deps.clock) },
  });

// 25.12.2026 starts at 2026-12-24T23:00Z in Zurich.
const UNTIL = { SLOPPANIZER_LOCAL_LOGIN_UNTIL: "2026-12-25", SLOPPANIZER_DEFAULT_TZ: "Europe/Zurich" };

describe("the own login ends (SLOPPANIZER_LOCAL_LOGIN_UNTIL)", () => {
  it("works until the day starts, then answers 410 pointing to omeldar; open sessions keep working", async () => {
    const { t, post } = await omeldarApp("both", { a: { sub: "usr_a", preferred_username: "anna" } }, UNTIL);
    expect(json(await t.app.inject({ method: "GET", url: "/api/v1/auth/config" }))).toMatchObject({
      mode: "both",
      signupsOpen: true,
      localLoginEnds: { on: "2026-12-25", at: "2026-12-24T23:00:00.000Z" },
    });

    t.setNow("2026-12-24T22:59:00.000Z");
    expect((await passwordLogin(t)).statusCode).toBe(200);

    t.setNow("2026-12-24T23:00:00.000Z");
    const refused = await passwordLogin(t);
    expect(refused.statusCode).toBe(410);
    expect(json<{ error: { code: string; message: string } }>(refused).error).toMatchObject({
      code: "gone",
    });
    expect(json<{ error: { message: string } }>(refused).error.message).toContain("ended on 2026-12-25");
    const others = [
      "/api/v1/auth/passkey/options",
      "/api/v1/auth/passkey/login",
      "/api/v1/auth/signup",
      "/api/v1/auth/reset",
      "/api/v1/auth/setup",
    ];
    const answers = await Promise.all(others.map(async (url) => [url, (await post(url, {})).statusCode]));
    expect(Object.fromEntries(answers)).toEqual(Object.fromEntries(others.map((url) => [url, 410])));
    expect(json(await t.app.inject({ method: "GET", url: "/api/v1/auth/config" }))).toMatchObject({
      signupsOpen: false,
      setupNeeded: false,
      localLoginEnds: { on: "2026-12-25" },
    });

    // A session from before the end keeps working, can still confirm it is you, and can still move.
    expect((await t.call("GET", "/api/v1/todos")).statusCode).toBe(200);
    const reauth = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/reauth",
      headers: t.account.headers(),
      payload: { password: TEST_PASSWORD, code: codeAt(TEST_TOTP_SECRET, t.deps.clock) },
    });
    expect(reauth.statusCode).toBe(204);
    // Signing in with omeldar is never affected.
    expect((await post("/api/v1/auth/omeldar/callback", callbackBody("a"))).statusCode).toBe(200);
  });

  it("is ignored with SLOPPANIZER_AUTH=local (rollback stays one switch) and moot with oidc", async () => {
    const local = await omeldarApp("local", {}, UNTIL);
    local.t.setNow("2027-01-10T10:00:00.000Z");
    expect(json(await local.t.app.inject({ method: "GET", url: "/api/v1/auth/config" }))).toMatchObject({
      mode: "local",
      localLoginEnds: null,
    });
    expect((await passwordLogin(local.t)).statusCode).toBe(200);

    const oidc = await omeldarApp("oidc", {}, UNTIL);
    expect(json(await oidc.t.app.inject({ method: "GET", url: "/api/v1/auth/config" }))).toMatchObject({
      mode: "oidc",
      localLoginEnds: null,
    });
  });

  it("without it, nothing ends", async () => {
    const { t } = await omeldarApp("both", {});
    expect(json(await t.app.inject({ method: "GET", url: "/api/v1/auth/config" }))).toMatchObject({
      localLoginEnds: null,
    });
    t.setNow("2030-01-01T10:00:00.000Z");
    expect((await passwordLogin(t)).statusCode).toBe(200);
  });
});

const linkBody = (code: string) => ({ query: `?code=${code}&state=${pending.state}`, pending });

describe("moving a signed-in account's sign-in to omeldar", () => {
  const people = {
    mine: { sub: "usr_anna", preferred_username: "anna.b" },
    imported: { sub: "usr_imp", preferred_username: "anna", legacy_id: "1" },
    otherImported: { sub: "usr_bob", preferred_username: "bob", legacy_id: "999" },
    stale: { sub: "usr_stale", preferred_username: "anna", auth_time: 1 },
  } satisfies Record<string, Partial<User>>;

  it("binds the omeldar account of a fresh sign-in; then sign-in with omeldar finds the same account", async () => {
    const { t, post } = await omeldarApp("both", people);
    const todo = await t.create<{ id: number }>("/api/v1/todos", { title: "Old data" });
    expect(json(await t.call("GET", "/api/v1/account")).omeldarLinked).toBe(false);

    expect((await t.call("POST", "/api/v1/auth/omeldar/link/start")).statusCode).toBe(204);
    expect((await t.call("POST", "/api/v1/auth/omeldar/link", linkBody("mine"))).statusCode).toBe(204);
    expect(json(await t.call("GET", "/api/v1/account")).omeldarLinked).toBe(true);
    const row = t.deps.db.select().from(accounts).where(eq(accounts.id, t.account.id)).get();
    // Bound only: the username, name, role and own credentials stay as they were.
    expect(row).toMatchObject({ authSubject: "usr_anna", username: "anna", role: "user" });
    expect(row?.passwordHash).not.toBeNull();
    const event = t.deps.db.select().from(adminEvents).all().at(-1);
    expect(event).toMatchObject({ actor: "anna", action: "move_signin", target: "anna" });

    // Again: nothing to do, and the start says it already moved.
    expect((await t.call("POST", "/api/v1/auth/omeldar/link", linkBody("mine"))).statusCode).toBe(204);
    const again = await t.call("POST", "/api/v1/auth/omeldar/link/start");
    expect(again.statusCode).toBe(409);
    expect(json<{ error: { message: string } }>(again).error.message).toBe(
      "Your sign-in already moved to omeldar.",
    );
    expect((await t.call("POST", "/api/v1/auth/omeldar/link", linkBody("imported"))).statusCode).toBe(409);

    const signIn = await post("/api/v1/auth/omeldar/callback", callbackBody("mine"));
    const tokens = signIn.json<{ accessToken: string; account: { id: number } }>();
    expect(tokens.account.id).toBe(t.account.id);
    const mine = await t.withToken(tokens.accessToken, "GET", `/api/v1/todos/${todo.id}`);
    expect(mine.statusCode).toBe(200);
  });

  it("takes the account auth imported for this one", async () => {
    const { t } = await omeldarApp("both", people);
    expect((await t.call("POST", "/api/v1/auth/omeldar/link", linkBody("imported"))).statusCode).toBe(204);
    expect(t.deps.db.select().from(accounts).where(eq(accounts.id, t.account.id)).get()?.authSubject).toBe(
      "usr_imp",
    );
  });

  it("refuses another account's omeldar account, a stale sign-in there, and a session not confirmed lately", async () => {
    const { t } = await omeldarApp("both", people);
    const bob = await t.asAccount({ username: "bob" });
    expect((await bob.call("POST", "/api/v1/auth/omeldar/link", linkBody("mine"))).statusCode).toBe(204);

    const taken = await t.call("POST", "/api/v1/auth/omeldar/link", linkBody("mine"));
    expect(taken.statusCode).toBe(409);
    expect(json<{ error: { details?: { reason?: string } } }>(taken).error.details?.reason).toBe(
      "other_account",
    );
    expect((await t.call("POST", "/api/v1/auth/omeldar/link", linkBody("otherImported"))).statusCode).toBe(
      409,
    );
    const stale = await t.call("POST", "/api/v1/auth/omeldar/link", linkBody("stale"));
    expect(stale.statusCode).toBe(403);

    // A session whose last full sign-in is older than 10 minutes must confirm it is you first.
    t.advance(11 * 60_000);
    const unconfirmed = await t.app.inject({
      method: "POST",
      url: "/api/v1/auth/omeldar/link/start",
      headers: t.account.headers(),
    });
    expect(unconfirmed.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(unconfirmed).error.code).toBe("reauth_required");
    expect(
      t.deps.db.select().from(accounts).where(eq(accounts.id, t.account.id)).get()?.authSubject,
    ).toBeNull();
  });

  it("does not exist while sign-in with omeldar is off", async () => {
    const { t } = await omeldarApp("local", {});
    expect((await t.call("POST", "/api/v1/auth/omeldar/link/start")).statusCode).toBe(404);
  });
});
