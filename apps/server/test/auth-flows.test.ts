import { normalizeOneTimeCode } from "@organizer/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { accounts, adminEvents, sessions } from "../src/db/auth-schema.ts";
import { unknownRouteBody } from "../src/http/web.ts";
import { resetAccountLogin } from "../src/services/auth/admin.ts";
import { totpCode } from "../src/services/auth/totp.ts";
import { runHourlyJobs } from "../src/services/jobs.ts";
import { createToken } from "../src/services/tokens.ts";
import { type AuthApp, makeAuthApp, SETUP_CODE, TEST_PASSWORD, TEST_TOTP_SECRET } from "./auth-helpers.ts";

const SECRET_B = "KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU";
const NEW_PASSWORD = "seven quiet ferries cross the bay";
const STEP = 30_000;
const DAY = 86_400_000;

const code = (t: AuthApp, secret = TEST_TOTP_SECRET) => totpCode(secret, t.clock().getTime());
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function setupAdmin(t: AuthApp, username = "boss") {
  const res = await t.call("POST", "/api/v1/auth/setup", {
    setupCode: SETUP_CODE.toLowerCase(),
    username,
    displayName: "The Boss",
    password: TEST_PASSWORD,
    timeZone: "Europe/Zurich",
    totpSecret: TEST_TOTP_SECRET,
    totpCode: code(t),
  });
  expect(res.statusCode).toBe(201);
  t.advance(STEP);
  return res.json();
}

const signupBody = (t: AuthApp, username = "petra", extra: Record<string, unknown> = {}) => ({
  username,
  displayName: "Petra",
  password: NEW_PASSWORD,
  note: "From the office",
  timeZone: "Europe/Berlin",
  totpSecret: SECRET_B,
  totpCode: code(t, SECRET_B),
  ...extra,
});

const login = (t: AuthApp, username: string, extra: Record<string, unknown>) =>
  t.call("POST", "/api/v1/auth/login", { username, ...extra });

describe("first admin setup", () => {
  it("creates an active, seeded admin with recovery codes and a session; then the route is gone", async () => {
    const t = await makeAuthApp();
    expect((await t.call("GET", "/api/v1/auth/config")).json()).toEqual({
      signupsOpen: true,
      setupNeeded: true,
      rpId: "app.example.test",
      mode: "local",
      omeldar: null,
      localLoginEnds: null,
    });
    const body = await setupAdmin(t);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.recoveryCodes[0]).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(body.session.account).toMatchObject({ username: "boss", role: "admin" });
    const me = await t.call("GET", "/api/v1/me", undefined, bearer(body.session.accessToken));
    expect(me.json()).toMatchObject({ via: "session", account: { username: "boss" } });
    const labels = await t.call("GET", "/api/v1/labels", undefined, bearer(body.session.accessToken));
    expect(labels.json().map((l: { name: string }) => l.name)).toContain("priority::high");

    expect((await t.call("GET", "/api/v1/auth/config")).json().setupNeeded).toBe(false);
    const again = await t.call("POST", "/api/v1/auth/setup", {
      setupCode: SETUP_CODE,
      username: "second",
      displayName: "Second",
      password: NEW_PASSWORD,
      timeZone: "UTC",
      totpSecret: SECRET_B,
      totpCode: code(t, SECRET_B),
    });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toEqual(unknownRouteBody("POST", "/api/v1/auth/setup"));
  });

  it("refuses a wrong code, a common password and a code that does not fit the secret", async () => {
    const t = await makeAuthApp();
    const base = {
      setupCode: SETUP_CODE,
      username: "boss",
      displayName: "Boss",
      password: TEST_PASSWORD,
      timeZone: "UTC",
      totpSecret: TEST_TOTP_SECRET,
      totpCode: code(t),
    };
    const wrong = await t.call("POST", "/api/v1/auth/setup", {
      ...base,
      setupCode: "AAAA-BBBB-CCCC-DDDD-EEEE",
    });
    expect(wrong.statusCode).toBe(401);
    const common = await t.call("POST", "/api/v1/auth/setup", { ...base, password: "password1234!" });
    expect(common.statusCode).toBe(422);
    const badCode = await t.call("POST", "/api/v1/auth/setup", {
      ...base,
      totpCode: "000000" === code(t) ? "111111" : "000000",
    });
    expect(badCode.statusCode).toBe(422);
    const withName = await t.call("POST", "/api/v1/auth/setup", {
      ...base,
      password: "boss boss boss boss!",
    });
    expect(withName.statusCode).toBe(422);
    expect(t.deps.db.select().from(accounts).all()).toHaveLength(0);
  });

  it("prints a new setup code at each start while no admin exists; only the newest works", async () => {
    const first = await makeAuthApp({ env: { SLOPPANIZER_SETUP_CODE: "" } });
    const line = first.logs.find((l) => l.includes("No admin account yet"));
    expect(line).toContain("Open https://app.example.test/setup and enter the setup code: ");
    const oldCode = /setup code: ([A-Z2-7-]+)/.exec(line ?? "")?.[1] as string;
    await first.close();

    const second = await makeAuthApp({ env: { SLOPPANIZER_SETUP_CODE: "" }, dataDir: first.dataDir });
    const newCode = /setup code: ([A-Z2-7-]+)/.exec(
      second.logs.find((l) => l.includes("setup code")) ?? "",
    )?.[1];
    expect(newCode).toBeDefined();
    expect(normalizeOneTimeCode(newCode as string)).not.toBe(normalizeOneTimeCode(oldCode));
    const body = {
      username: "boss",
      displayName: "Boss",
      password: TEST_PASSWORD,
      timeZone: "UTC",
      totpSecret: TEST_TOTP_SECRET,
      totpCode: code(second),
    };
    expect(
      (await second.call("POST", "/api/v1/auth/setup", { ...body, setupCode: oldCode })).statusCode,
    ).toBe(401);
    expect(
      (await second.call("POST", "/api/v1/auth/setup", { ...body, setupCode: newCode })).statusCode,
    ).toBe(201);
    await second.close();

    const third = await makeAuthApp({ env: { SLOPPANIZER_SETUP_CODE: "" }, dataDir: first.dataDir });
    expect(third.logs.some((l) => l.includes("setup code"))).toBe(false);
  });

  it("prints nothing when the env fixes the code", async () => {
    const t = await makeAuthApp();
    expect(t.logs.some((l) => l.includes("setup code"))).toBe(false);
  });
});

describe("sign-up", () => {
  it("creates a pending account with 10 recovery codes and logs it for the admin", async () => {
    const t = await makeAuthApp();
    const res = await t.call("POST", "/api/v1/auth/signup", signupBody(t));
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("pending");
    expect(res.json().recoveryCodes).toHaveLength(10);
    const row = t.deps.db.select().from(accounts).where(eq(accounts.username, "petra")).get();
    expect(row).toMatchObject({
      status: "pending",
      role: "user",
      signupNote: "From the office",
      timeZone: "Europe/Berlin",
    });
    expect(row?.totpSecretEnc).not.toContain(SECRET_B);
    // No region: the Swiss formats.
    expect(row).toMatchObject({ dateFormat: "dmy.", timeFormat: "24h" });
    expect(
      t.deps.db
        .select()
        .from(adminEvents)
        .all()
        .map((e) => [e.actor, e.action, e.target]),
    ).toEqual([["system", "signup", "petra"]]);
  });

  it("presets the date and time formats from the region", async () => {
    const t = await makeAuthApp();
    const res = await t.call("POST", "/api/v1/auth/signup", signupBody(t, "petra", { region: "us" }));
    expect(res.statusCode).toBe(201);
    const row = t.deps.db.select().from(accounts).where(eq(accounts.username, "petra")).get();
    expect(row).toMatchObject({ dateFormat: "mdy/", timeFormat: "12h" });
  });

  it("answers 409 for a taken name (pending too, any case) and 422 for a password with the name", async () => {
    const t = await makeAuthApp();
    expect((await t.call("POST", "/api/v1/auth/signup", signupBody(t))).statusCode).toBe(201);
    t.advance(STEP);
    const taken = await t.call("POST", "/api/v1/auth/signup", signupBody(t, "PETRA"));
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.message).toBe("That username is taken. Pick another.");
    const named = await t.call(
      "POST",
      "/api/v1/auth/signup",
      signupBody(t, "karl", { password: "karl is my favourite name" }),
    );
    expect(named.statusCode).toBe(422);
    const reserved = await t.call("POST", "/api/v1/auth/signup", signupBody(t, "admin-cli"));
    expect(reserved.statusCode).toBe(422);
  });

  it("is paused when closed or when 50 sign-ups wait", async () => {
    const closed = await makeAuthApp({ env: { SLOPPANIZER_SIGNUPS: "closed" } });
    const res = await closed.call("POST", "/api/v1/auth/signup", signupBody(closed));
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("Sign-ups are paused right now. Try again later.");
    expect((await closed.call("GET", "/api/v1/auth/config")).json().signupsOpen).toBe(false);

    const full = await makeAuthApp();
    for (let i = 0; i < 50; i++) {
      // oxlint-disable-next-line no-await-in-loop -- accounts are made one after the other
      await full.account({ username: `wait${i}`, status: "pending", password: null });
    }
    expect((await full.call("POST", "/api/v1/auth/signup", signupBody(full))).statusCode).toBe(403);
  });

  it("limits sign-ups to 5 per IP per hour with Retry-After", async () => {
    const t = await makeAuthApp();
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line no-await-in-loop -- counted in order
      await t.call("POST", "/api/v1/auth/signup", signupBody(t, `user${i}`, { totpCode: "123456" }));
    }
    const res = await t.call("POST", "/api/v1/auth/signup", signupBody(t, "late"));
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(3000);
    expect(res.json().error.details.retryAfterSeconds).toBe(Number(res.headers["retry-after"]));
  });

  it("waits for approval: correct credentials say so, wrong ones get the normal 401; expires after 30 days", async () => {
    const t = await makeAuthApp();
    await t.call("POST", "/api/v1/auth/signup", signupBody(t));
    t.advance(STEP);
    const ok = await login(t, "petra", { password: NEW_PASSWORD, code: code(t, SECRET_B) });
    expect(ok.statusCode).toBe(403);
    expect(ok.json().error).toEqual({
      code: "forbidden",
      message: "Your account waits for approval.",
      details: { reason: "pending" },
    });
    const wrong = await login(t, "petra", { password: "not the password at all", code: code(t, SECRET_B) });
    expect(wrong.statusCode).toBe(401);

    t.advance(29 * DAY);
    expect(runHourlyJobs({ db: t.deps.db, clock: t.clock, config: t.config }).expiredSignups).toBe(0);
    t.advance(DAY + 1000);
    expect(runHourlyJobs({ db: t.deps.db, clock: t.clock, config: t.config }).expiredSignups).toBe(1);
    expect(t.deps.db.select().from(accounts).all()).toHaveLength(0);
    expect(t.deps.db.select().from(adminEvents).all().at(-1)).toMatchObject({
      action: "expire_signup",
      target: "petra",
    });
  });
});

describe("login", () => {
  it("signs in with password and code, then the code is used up", async () => {
    const t = await makeAuthApp();
    await t.account({ username: "anna" });
    const res = await login(t, "Anna ", { password: TEST_PASSWORD, code: code(t) });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ account: { username: "anna" }, recoveryCodesLeft: null });
    expect(body.accessToken).toMatch(/^spa_/);
    expect(body.refreshToken).toMatch(/^spr_[0-9A-Za-z]{43}$/);
    expect(Date.parse(body.accessExpiresAt) - t.clock().getTime()).toBe(15 * 60_000);
    const replay = await login(t, "anna", { password: TEST_PASSWORD, code: code(t) });
    expect(replay.statusCode).toBe(401);
    const row = t.deps.db.select().from(accounts).where(eq(accounts.username, "anna")).get();
    expect(row?.lastLoginAt).toBe(t.clock().toISOString());
  });

  it("gives every wrong part the same answer and runs the hash for unknown names", async () => {
    const t = await makeAuthApp();
    await t.account({ username: "anna" });
    const burn = vi.spyOn(t.auth.dummyHash, "burn");
    const answers = await Promise.all([
      login(t, "nobody", { password: TEST_PASSWORD, code: code(t) }),
      login(t, "anna", { password: "wrong password here", code: code(t) }),
      login(t, "anna", { password: TEST_PASSWORD, code: code(t) === "123456" ? "654321" : "123456" }),
      login(t, "anna", { password: TEST_PASSWORD, recoveryCode: "aaaa-bbbb-cccc-dddd" }),
      login(t, "anna", { recoveryCode: "aaaa-bbbb-cccc-dddd" }),
    ]);
    expect(answers.map((r) => r.statusCode)).toEqual([401, 401, 401, 401, 401]);
    expect(new Set(answers.map((r) => r.body)).size).toBe(1);
    expect(answers[0]?.json().error.message).toBe("Wrong username, password or code.");
    // The unknown name and the recovery-code-only attempt ran the dummy hash.
    expect(burn).toHaveBeenCalledTimes(2);
  });

  it("says disabled only with correct credentials", async () => {
    const t = await makeAuthApp();
    await t.account({ username: "anna", status: "disabled" });
    const ok = await login(t, "anna", { password: TEST_PASSWORD, code: code(t) });
    expect(ok.statusCode).toBe(403);
    expect(ok.json().error.details).toEqual({ reason: "disabled" });
    expect(ok.json().error.message).toBe("This account is disabled. Ask the admin.");
    t.advance(STEP);
    expect((await login(t, "anna", { password: "wrong password here", code: code(t) })).statusCode).toBe(401);
  });

  it("takes a recovery code once and tells how many are left", async () => {
    const t = await makeAuthApp();
    const anna = await t.account({ username: "anna" });
    const recovery = (anna.recoveryCodes[3] as string).replaceAll("-", "").toUpperCase();
    const first = await login(t, "anna", { password: TEST_PASSWORD, recoveryCode: recovery });
    expect(first.statusCode).toBe(200);
    expect(first.json().recoveryCodesLeft).toBe(9);
    const second = await login(t, "anna", { password: TEST_PASSWORD, recoveryCode: recovery });
    expect(second.statusCode).toBe(401);
    // A password account cannot sign in with a recovery code alone.
    expect((await login(t, "anna", { recoveryCode: anna.recoveryCodes[4] })).statusCode).toBe(401);
  });

  it("locks a name after 5 failures for 1, 2, 4 minutes, for unknown names alike, across a restart", async () => {
    const t = await makeAuthApp();
    await t.account({ username: "anna" });
    const fail = (name: string) => login(t, name, { password: "wrong password here", code: "123456" });
    for (const name of ["anna", "ghost"]) {
      for (let i = 0; i < 5; i++) {
        // oxlint-disable-next-line no-await-in-loop -- failures count in order
        expect((await fail(name)).statusCode).toBe(401);
      }
      // oxlint-disable-next-line no-await-in-loop -- in order
      const locked = await fail(name);
      expect(locked.statusCode).toBe(429);
      expect(locked.json().error.message).toBe("Too many attempts. Try again in 1 minute.");
      expect(locked.headers["retry-after"]).toBe("60");
    }
    // Locked: even the right password is refused.
    expect((await login(t, "anna", { password: TEST_PASSWORD, code: code(t) })).statusCode).toBe(429);

    t.advance(60_000);
    expect((await fail("anna")).statusCode).toBe(401);
    const twoMinutes = await fail("anna");
    expect(twoMinutes.json().error.message).toBe("Too many attempts. Try again in 2 minutes.");
    await t.close();

    const restarted = await makeAuthApp({ dataDir: t.dataDir, now: t.clock().toISOString() });
    expect(
      (await login(restarted, "anna", { password: TEST_PASSWORD, code: code(restarted) })).statusCode,
    ).toBe(429);
    restarted.advance(2 * 60_000);
    expect(
      (await login(restarted, "anna", { password: TEST_PASSWORD, code: code(restarted) })).statusCode,
    ).toBe(200);
    // Success cleared the count: the next failure is a plain 401 again.
    restarted.advance(STEP);
    expect(
      (await login(restarted, "anna", { password: "wrong password here", code: "123456" })).statusCode,
    ).toBe(401);
  });

  it("blocks an IP for 15 minutes after 20 failed logins", async () => {
    const t = await makeAuthApp();
    await t.account({ username: "anna" });
    for (let i = 0; i < 20; i++) {
      // oxlint-disable-next-line no-await-in-loop -- failures count in order
      await login(t, `name${i}`, { password: "wrong password here", code: "123456" });
    }
    const blocked = await login(t, "anna", { password: TEST_PASSWORD, code: code(t) });
    expect(blocked.statusCode).toBe(429);
    t.advance(15 * 60_000);
    expect((await login(t, "anna", { password: TEST_PASSWORD, code: code(t) })).statusCode).toBe(200);
  });
});

async function signedIn(t: AuthApp) {
  await t.account({ username: "anna", signedIn: false });
  const res = await login(t, "anna", { password: TEST_PASSWORD, code: code(t) });
  return res.json() as { accessToken: string; refreshToken: string; sessionId: string };
}
const refresh = (t: AuthApp, refreshToken: string) =>
  t.call("POST", "/api/v1/auth/refresh", { refreshToken });

describe("refresh and logout", () => {
  it("rotates the refresh token; the previous one works again only within 60 s", async () => {
    const t = await makeAuthApp();
    const tokens = await signedIn(t);
    t.advance(1000);
    const first = await refresh(t, tokens.refreshToken);
    expect(first.statusCode).toBe(200);
    expect(first.json().refreshToken).not.toBe(tokens.refreshToken);
    expect(first.json().sessionId).toBe(tokens.sessionId);
    // A lost answer or a second tab: the old token is accepted within the grace and rotates again.
    t.advance(30_000);
    const raced = await refresh(t, tokens.refreshToken);
    expect(raced.statusCode).toBe(200);
    // Later, the old token counts as stolen: the whole session ends.
    t.advance(31_000);
    const reused = await refresh(t, tokens.refreshToken);
    expect(reused.statusCode).toBe(401);
    expect((await refresh(t, raced.json().refreshToken)).statusCode).toBe(401);
    const row = t.deps.db.select().from(sessions).where(eq(sessions.id, tokens.sessionId)).get();
    expect(row?.revokeReason).toBe("refresh_reuse");
    const me = await t.call("GET", "/api/v1/me", undefined, bearer(raced.json().accessToken));
    expect(me.statusCode).toBe(401);
  });

  it("ends a session idle for 30 days and any session after 90 days", async () => {
    const t = await makeAuthApp();
    const tokens = await signedIn(t);
    t.advance(30 * DAY + 1000);
    expect((await refresh(t, tokens.refreshToken)).statusCode).toBe(401);

    const u = await makeAuthApp();
    let current = (await signedIn(u)).refreshToken;
    for (let i = 0; i < 4; i++) {
      u.advance(20 * DAY);
      // oxlint-disable-next-line no-await-in-loop -- each refresh needs the token of the one before
      const res = await refresh(u, current);
      expect(res.statusCode).toBe(200);
      current = res.json().refreshToken;
    }
    u.advance(10 * DAY + 1000);
    expect((await refresh(u, current)).statusCode).toBe(401);
  });

  it("refuses refresh for a disabled account and for junk tokens", async () => {
    const t = await makeAuthApp();
    const tokens = await signedIn(t);
    t.deps.db.update(accounts).set({ status: "disabled" }).run();
    expect((await refresh(t, tokens.refreshToken)).statusCode).toBe(401);
    expect((await refresh(t, "spr_nope")).statusCode).toBe(401);
    expect((await refresh(t, `spa_${"x".repeat(43)}`)).statusCode).toBe(401);
  });

  it("logs out: the access and refresh tokens stop working at once", async () => {
    const t = await makeAuthApp();
    const tokens = await signedIn(t);
    const out = await t.call("POST", "/api/v1/auth/logout", undefined, bearer(tokens.accessToken));
    expect(out.statusCode).toBe(204);
    expect((await t.call("GET", "/api/v1/me", undefined, bearer(tokens.accessToken))).statusCode).toBe(401);
    expect((await refresh(t, tokens.refreshToken)).statusCode).toBe(401);
  });

  it("rate limits refresh per session (60 per minute)", async () => {
    const t = await makeAuthApp();
    let current = (await signedIn(t)).refreshToken;
    for (let i = 0; i < 60; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each refresh needs the token of the one before
      current = (await refresh(t, current)).json().refreshToken;
    }
    const limited = await refresh(t, current);
    expect(limited.statusCode).toBe(429);
    t.advance(60_000);
    expect((await refresh(t, current)).statusCode).toBe(200);
  });
});

describe("login reset by the admin", () => {
  it("clears the factors and sessions, keeps data and tokens; the code works once within 24 hours", async () => {
    const t = await makeAuthApp();
    const anna = await t.account({ username: "anna" });
    const token = createToken(t.deps.db, t.deps.clock, anna.id, { name: "script", scope: "read" }).raw;
    const before = await t.call("GET", "/api/v1/labels", undefined, anna.headers());
    const { resetCode } = resetAccountLogin(
      t.deps.db,
      t.clock().getTime(),
      { name: "cli", accountId: null },
      anna.id,
    );
    expect(resetCode).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){4}$/);
    expect((await t.call("GET", "/api/v1/me", undefined, anna.headers())).statusCode).toBe(401);
    expect((await t.call("GET", "/api/v1/me", undefined, bearer(token))).statusCode).toBe(200);
    t.advance(STEP);
    expect((await login(t, "anna", { password: TEST_PASSWORD, code: code(t) })).statusCode).toBe(401);
    expect((await login(t, "anna", { recoveryCode: anna.recoveryCodes[0] })).statusCode).toBe(401);

    const resetBody = {
      username: "anna",
      resetCode: resetCode.toLowerCase(),
      password: NEW_PASSWORD,
      totpSecret: SECRET_B,
      totpCode: code(t, SECRET_B),
    };
    const wrong = await t.call("POST", "/api/v1/auth/reset", {
      ...resetBody,
      resetCode: "AAAA-BBBB-CCCC-DDDD-EEEE",
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe("Wrong username or reset code, or the code has expired.");
    const done = await t.call("POST", "/api/v1/auth/reset", resetBody);
    expect(done.statusCode).toBe(200);
    expect(done.json().recoveryCodes).toHaveLength(10);
    t.advance(STEP);
    expect(
      (await t.call("POST", "/api/v1/auth/reset", { ...resetBody, totpCode: code(t, SECRET_B) })).statusCode,
    ).toBe(401);

    const relogin = await login(t, "anna", { password: NEW_PASSWORD, code: code(t, SECRET_B) });
    expect(relogin.statusCode).toBe(200);
    const after = await t.call("GET", "/api/v1/labels", undefined, bearer(relogin.json().accessToken));
    expect(after.json()).toEqual(before.json());
    const row = t.deps.db.select().from(accounts).where(eq(accounts.username, "anna")).get();
    expect(row?.loginResetAt).not.toBeNull();
  });

  it("refuses an expired code", async () => {
    const t = await makeAuthApp();
    const anna = await t.account({ username: "anna" });
    const { resetCode } = resetAccountLogin(
      t.deps.db,
      t.clock().getTime(),
      { name: "cli", accountId: null },
      anna.id,
    );
    t.advance(DAY + 1000);
    const res = await t.call("POST", "/api/v1/auth/reset", {
      username: "anna",
      resetCode,
      password: NEW_PASSWORD,
      totpSecret: SECRET_B,
      totpCode: code(t, SECRET_B),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("logs", () => {
  it("never contain passwords, codes or tokens of a sign-up, setup, login and refresh", async () => {
    const t = await makeAuthApp({ env: { LOG_LEVEL: "debug" } });
    const setup = await setupAdmin(t);
    const signup = await t.call("POST", "/api/v1/auth/signup", signupBody(t));
    const signin = await login(t, "boss", { password: TEST_PASSWORD, code: code(t) });
    const refreshed = await t.call("POST", "/api/v1/auth/refresh", {
      refreshToken: signin.json().refreshToken,
    });
    await t.call("GET", "/api/v1/me", undefined, bearer(refreshed.json().accessToken));
    const secrets = [
      TEST_PASSWORD,
      NEW_PASSWORD,
      TEST_TOTP_SECRET,
      SECRET_B,
      normalizeOneTimeCode(SETUP_CODE),
      SETUP_CODE,
      ...setup.recoveryCodes,
      ...signup.json().recoveryCodes,
      setup.session.accessToken,
      setup.session.refreshToken,
      signin.json().accessToken,
      signin.json().refreshToken,
      refreshed.json().accessToken,
      refreshed.json().refreshToken,
    ];
    const text = t.logs.join("\n");
    expect(t.logs.length).toBeGreaterThan(5);
    for (const secret of secrets) expect(text).not.toContain(secret);
  });
});
