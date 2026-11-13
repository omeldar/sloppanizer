import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { accessKey, mintAccessToken, readAccessToken } from "../src/services/auth/access-token.ts";
import { ChallengeStore, CHALLENGE_TTL_MS } from "../src/services/auth/challenges.ts";
import { isCommonPassword } from "../src/services/auth/common-passwords.ts";
import {
  DataKeyError,
  DecryptError,
  decryptSecret,
  encryptSecret,
  loadDataKey,
  parseDataKey,
  safeEqual,
} from "../src/services/auth/crypto.ts";
import { hashPassword, Semaphore, verifyPassword } from "../src/services/auth/password.ts";
import { base32Decode, hotp, totpCode, verifyTotp } from "../src/services/auth/totp.ts";
import { FixedWindowLimiter, waitText } from "../src/http/rate-limit.ts";
import { lockDurationMs } from "../src/services/auth/throttle.ts";
import { deviceName } from "../src/services/auth/user-agent.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("TOTP (RFC 6238)", () => {
  // RFC 6238 appendix B, SHA-1, secret "12345678901234567890", 8 digits.
  const key = Buffer.from("12345678901234567890", "ascii");
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("time %i gives %s", (seconds, code) => {
    expect(hotp(key, Math.floor(seconds / 30), 8)).toBe(code);
  });

  it("decodes base32 like authenticator apps", () => {
    expect(base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ").toString("ascii")).toBe("12345678901234567890");
  });

  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  const now = 1_700_000_000_000;

  it("accepts the codes of one step back, now and one ahead, nothing further", () => {
    const step = Math.floor(now / 30_000);
    for (const offset of [-1, 0, 1]) {
      expect(verifyTotp(secret, totpCode(secret, now + offset * 30_000), now, null)).toBe(step + offset);
    }
    expect(verifyTotp(secret, totpCode(secret, now - 60_000), now, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 60_000), now, null)).toBeNull();
  });

  it("refuses a step at or below the last used one (no replay, no older code)", () => {
    const code = totpCode(secret, now);
    const step = verifyTotp(secret, code, now, null) as number;
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now, step)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now + 30_000, step)).toBe(step + 1);
  });
});

describe("passwords (argon2id PHC)", () => {
  const small = { memory: 1024, passes: 1, parallelism: 1 };

  it("round trips and refuses a wrong password", async () => {
    const phc = await hashPassword("a long enough password", small);
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(await verifyPassword("a long enough password", phc, small)).toEqual({
      ok: true,
      needsRehash: false,
    });
    expect((await verifyPassword("a long enough passworD", phc, small)).ok).toBe(false);
  });

  it("asks for a rehash when today's parameters differ, only after a correct password", async () => {
    const phc = await hashPassword("a long enough password", small);
    const today = { memory: 2048, passes: 2, parallelism: 1 };
    expect(await verifyPassword("a long enough password", phc, today)).toEqual({
      ok: true,
      needsRehash: true,
    });
    expect(await verifyPassword("wrong one entirely", phc, today)).toEqual({ ok: false, needsRehash: false });
  });

  it("uses the production parameters by default and salts every hash", async () => {
    const [a, b] = await Promise.all([
      hashPassword("same password twice"),
      hashPassword("same password twice"),
    ]);
    expect(a).toContain("$m=19456,t=2,p=1$");
    expect(a).not.toBe(b);
  });

  it("refuses broken hash strings without throwing", async () => {
    expect(await verifyPassword("x", "$argon2i$v=19$m=1,t=1,p=1$AA$AA")).toEqual({
      ok: false,
      needsRehash: false,
    });
    expect(await verifyPassword("x", "")).toEqual({ ok: false, needsRehash: false });
  });

  it("runs at most N tasks at once", async () => {
    const gate = new Semaphore(2);
    let peak = 0;
    const tasks = Array.from({ length: 6 }, () =>
      gate.run(async () => {
        peak = Math.max(peak, gate.running);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }),
    );
    await Promise.all(tasks);
    expect(peak).toBe(2);
  });

  it("knows common passwords that pass the length rule", () => {
    expect(isCommonPassword("password1234")).toBe(true);
    expect(isCommonPassword("qwertyuiop123")).toBe(true);
    expect(isCommonPassword("violet tram drifts over 9 hills")).toBe(false);
    expect(isCommonPassword("correct horse battery staple")).toBe(true);
  });
});

describe("data key and secret encryption", () => {
  const key = Buffer.alloc(32, 7);

  it("encrypts with a fresh iv and decrypts with the same key and purpose", () => {
    const a = encryptSecret(key, "JBSWY3DPEHPK3PXP", "totp");
    const b = encryptSecret(key, "JBSWY3DPEHPK3PXP", "totp");
    expect(a).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(a).not.toBe(b);
    expect(decryptSecret(key, a, "totp")).toBe("JBSWY3DPEHPK3PXP");
  });

  it("refuses a changed value, another key and another purpose", () => {
    const value = encryptSecret(key, "JBSWY3DPEHPK3PXP", "totp");
    const [v, iv, body, tag] = value.split(":") as [string, string, string, string];
    const flipped = `${v}:${iv}:${body.startsWith("A") ? `B${body.slice(1)}` : `A${body.slice(1)}`}:${tag}`;
    expect(() => decryptSecret(key, flipped, "totp")).toThrow(DecryptError);
    expect(() => decryptSecret(Buffer.alloc(32, 8), value, "totp")).toThrow(DecryptError);
    expect(() => decryptSecret(key, value, "other")).toThrow(DecryptError);
    expect(() => decryptSecret(key, "v2:a:b:c", "totp")).toThrow(DecryptError);
  });

  it("parses a 32 byte base64 key and refuses anything else", () => {
    expect(parseDataKey(Buffer.alloc(32, 1).toString("base64")).length).toBe(32);
    expect(() => parseDataKey("short")).toThrow(DataKeyError);
    expect(() => parseDataKey(Buffer.alloc(16, 1).toString("base64"))).toThrow(DataKeyError);
  });

  it("makes a 0600 key file once in development and reuses it", () => {
    const dir = mkdtempSync(join(tmpdir(), "spz-key-"));
    dirs.push(dir);
    const first = loadDataKey(dir, null);
    expect(statSync(join(dir, "data-key")).mode & 0o777).toBe(0o600);
    expect(loadDataKey(dir, null).equals(first)).toBe(true);
    const fromEnv = Buffer.alloc(32, 3);
    expect(loadDataKey(dir, fromEnv)).toBe(fromEnv);
    writeFileSync(join(dir, "data-key"), "broken");
    expect(() => loadDataKey(dir, null)).toThrow(DataKeyError);
  });

  it("compares strings in constant time without throwing on other lengths", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("access tokens", () => {
  const key = accessKey("x".repeat(64));
  const sid = "0123456789abcdef0123456789abcdef";

  it("reads back a well signed token until it expires", () => {
    const token = mintAccessToken(key, { sid, aid: 4, exp: 2000 });
    expect(token).toMatch(/^spa_[\w-]+\.[\w-]{43}$/);
    expect(readAccessToken(key, token, 1999)).toEqual({ sid, aid: 4, exp: 2000 });
    expect(readAccessToken(key, token, 2000)).toBeNull();
  });

  it("refuses another key, a changed payload and junk", () => {
    const token = mintAccessToken(key, { sid, aid: 4, exp: 2000 });
    expect(readAccessToken(accessKey("y".repeat(64)), token, 1000)).toBeNull();
    const [body, signature] = token.slice(4).split(".") as [string, string];
    const forged = Buffer.from(JSON.stringify({ sid, aid: 5, exp: 2000 })).toString("base64url");
    expect(readAccessToken(key, `spa_${forged}.${signature}`, 1000)).toBeNull();
    expect(readAccessToken(key, `spa_${body}.${signature.slice(1)}x`, 1000)).toBeNull();
    expect(readAccessToken(key, "spa_nonsense", 1000)).toBeNull();
    const badShape = mintAccessToken(key, { sid: "nothex", aid: 4, exp: 2000 });
    expect(readAccessToken(key, badShape, 1000)).toBeNull();
  });
});

describe("challenge store", () => {
  it("hands a challenge out once, only for its kind and binding, within 5 minutes", () => {
    let now = 0;
    const store = new ChallengeStore(() => now);
    const id = store.add({ kind: "reauth", challenge: "c", accountId: 1, sessionId: "s" });
    expect(store.take(id, "reauth", { accountId: 2, sessionId: "s" })).toBeNull();
    // A wrong binding burns it.
    expect(store.take(id, "reauth", { accountId: 1, sessionId: "s" })).toBeNull();

    const ok = store.add({ kind: "login", challenge: "d" });
    expect(store.take(ok, "reauth")).toBeNull();
    const again = store.add({ kind: "login", challenge: "e" });
    expect(store.take(again, "login")?.challenge).toBe("e");
    expect(store.take(again, "login")).toBeNull();

    const late = store.add({ kind: "login", challenge: "f" });
    now += CHALLENGE_TTL_MS;
    expect(store.take(late, "login")).toBeNull();
  });

  it("keeps at most 10000, dropping the oldest", () => {
    const store = new ChallengeStore(() => 0);
    const first = store.add({ kind: "login", challenge: "first" });
    for (let i = 0; i < 10_000; i++) store.add({ kind: "login", challenge: String(i) });
    expect(store.size).toBe(10_000);
    expect(store.take(first, "login")).toBeNull();
  });
});

describe("rate limits and lockout durations", () => {
  it("counts per key in fixed windows and says when to come back", () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(() => new Date(now), 3, 60_000);
    expect([1, 2, 3].map(() => limiter.take("a").ok)).toEqual([true, true, true]);
    now = 15_000;
    expect(limiter.take("a")).toEqual({ ok: false, retryAfterSeconds: 45 });
    expect(limiter.take("b").ok).toBe(true);
    now = 60_000;
    expect(limiter.take("a").ok).toBe(true);
  });

  it("blocks for the block time once over the limit", () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(() => new Date(now), 2, 60_000, 15 * 60_000);
    limiter.take("ip");
    limiter.take("ip");
    now = 61_000;
    expect(limiter.check("ip").ok).toBe(false);
    now = 15 * 60_000;
    expect(limiter.check("ip").ok).toBe(true);
  });

  it("locks 1, 2, 4 ... minutes from the fifth failure, at most 60", () => {
    const minutes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => lockDurationMs(n) / 60_000);
    expect(minutes).toEqual([0, 0, 0, 0, 1, 2, 4, 8, 16, 32, 60, 60]);
  });

  it("says waits in plain words", () => {
    expect([1, 45, 60, 61, 240].map(waitText)).toEqual([
      "1 second",
      "45 seconds",
      "1 minute",
      "2 minutes",
      "4 minutes",
    ]);
  });
});

describe("device names", () => {
  it("names common browsers and systems", () => {
    expect(
      deviceName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      ),
    ).toBe("Chrome on Windows");
    expect(
      deviceName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Safari/604.1",
      ),
    ).toBe("Safari on iOS");
    expect(deviceName("")).toBe("Unknown device");
  });
});
