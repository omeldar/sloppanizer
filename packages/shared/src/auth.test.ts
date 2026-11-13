import { describe, expect, it } from "vitest";
import {
  ChangePassword,
  ConfirmUsername,
  Login,
  normalizeOneTimeCode,
  normalizeRecoveryCode,
  otpauthUri,
  passwordProblem,
  Reauth,
  RecoveryCode,
  ResetLogin,
  Setup,
  Signup,
  TotpCode,
  UpdateAccount,
  Username,
  WebAuthnResponse,
} from "./auth.ts";

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const passkey = {
  challengeId: "0123456789abcdef0123456789abcdef",
  response: { id: "abc", rawId: "abc", type: "public-key", response: { clientDataJSON: "e30" } },
  name: "Laptop",
};
const passwordSignup = {
  username: "Anna.M",
  displayName: " Anna ",
  password: "correct horse battery",
  timeZone: "Europe/Zurich",
  totpSecret: SECRET,
  totpCode: "123 456",
};

describe("usernames", () => {
  it("trims, lowercases and keeps the allowed characters", () => {
    expect(Username.parse("  Anna.Meier_2 ")).toBe("anna.meier_2");
  });

  it("refuses short, long, odd first characters, other characters and reserved names", () => {
    const bad = ["ab", "a".repeat(33), ".anna", "-anna", "an na", "anna!", "änna"];
    expect(bad.filter((name) => ok(Username, name))).toEqual([]);
    const reserved = ["you", "System", "admin-cli", "api"];
    expect(reserved.filter((name) => ok(Username, name))).toEqual([]);
    expect(ok(Username, "a".repeat(32))).toBe(true);
  });
});

describe("passwords", () => {
  it("needs 12 to 200 characters, more than one repeated character and not the username", () => {
    expect(passwordProblem("short")).toMatch(/12/);
    expect(passwordProblem("x".repeat(201))).toMatch(/200/);
    expect(passwordProblem("aaaaaaaaaaaaaa")).toMatch(/repeated/);
    expect(passwordProblem("my-Anna.M-password", "anna.m")).toMatch(/username/);
    expect(passwordProblem("correct horse battery", "anna")).toBeNull();
  });

  it("checks the username rule on sign-up, setup and reset objects", () => {
    expect(ok(Signup, passwordSignup)).toBe(true);
    expect(ok(Signup, { ...passwordSignup, password: "anna.m-is-my-password" })).toBe(false);
    const setup = { ...passwordSignup, setupCode: "ABCD-EFGH-IJKL-MNOP-QRST" };
    expect(ok(Setup, setup)).toBe(true);
    expect(ok(Setup, { ...setup, password: "xxanna.mxxxxxxxx" })).toBe(false);
    const reset = {
      username: "anna.m",
      resetCode: "ABCD-EFGH-IJKL-MNOP-QRST",
      password: "correct horse battery",
      totpSecret: SECRET,
      totpCode: "123456",
    };
    expect(ok(ResetLogin, reset)).toBe(true);
    expect(ok(ResetLogin, { ...reset, password: "ANNA.Mpassword" })).toBe(false);
  });

  it("refuses a new password with only one of authenticator secret and code", () => {
    expect(ok(ChangePassword, { newPassword: "correct horse battery" })).toBe(true);
    expect(
      ok(ChangePassword, { newPassword: "correct horse battery", totpSecret: SECRET, totpCode: "123456" }),
    ).toBe(true);
    expect(ok(ChangePassword, { newPassword: "correct horse battery", totpSecret: SECRET })).toBe(false);
  });
});

describe("sign-up shapes", () => {
  it("takes either password plus authenticator, or a passkey, never a mix", () => {
    const base = { username: "anna", displayName: "Anna", timeZone: "UTC" };
    expect(ok(Signup, { ...base, passkey })).toBe(true);
    expect(ok(Signup, { ...base, passkey, password: "correct horse battery" })).toBe(false);
    expect(ok(Signup, { ...base, password: "correct horse battery", totpSecret: SECRET })).toBe(false);
    expect(ok(Signup, { ...passwordSignup, extra: 1 })).toBe(false);
    expect(ok(Signup, { ...passwordSignup, timeZone: "Mars/Base" })).toBe(false);
    expect(ok(Signup, { ...passwordSignup, note: "x".repeat(301) })).toBe(false);
    expect(ok(Signup, { ...passwordSignup, totpSecret: "jbswy3dpehpk3pxpjbswy3dpehpk3pxp" })).toBe(false);
  });
});

describe("codes", () => {
  it("strips spaces from authenticator codes and wants 6 digits", () => {
    expect(TotpCode.parse(" 123 456 ")).toBe("123456");
    expect(ok(TotpCode, "12345")).toBe(false);
    expect(ok(TotpCode, "12345a")).toBe(false);
  });

  it("normalizes recovery codes with or without dashes, in any case", () => {
    expect(RecoveryCode.parse("ABCDEFGHIJKLMNOP")).toBe("abcd-efgh-ijkl-mnop");
    expect(RecoveryCode.parse(" abcd-efgh-ijkl-mnop ")).toBe("abcd-efgh-ijkl-mnop");
    expect(normalizeRecoveryCode("Abcd Efgh-ijkl mnop")).toBe("abcd-efgh-ijkl-mnop");
    // 0, 1, 8 and 9 are not base32.
    expect(ok(RecoveryCode, "abcd-efgh-ijkl-mno1")).toBe(false);
    expect(ok(RecoveryCode, "abcd-efgh-ijkl")).toBe(false);
  });

  it("compares setup and reset codes without case, spaces and dashes", () => {
    expect(normalizeOneTimeCode("abcd-efgh ijkl-MNOP-qrst")).toBe("ABCDEFGHIJKLMNOPQRST");
  });
});

describe("login and reauth", () => {
  it("accepts the three login forms and nothing else", () => {
    expect(Login.parse({ username: " Anna ", password: "pw", code: "123456" })).toEqual({
      username: "anna",
      password: "pw",
      code: "123456",
    });
    expect(ok(Login, { username: "anna", password: "pw", recoveryCode: "abcdefghijklmnop" })).toBe(true);
    expect(ok(Login, { username: "anna", recoveryCode: "abcdefghijklmnop" })).toBe(true);
    expect(ok(Login, { username: "anna", password: "pw" })).toBe(false);
    expect(
      ok(Login, { username: "anna", password: "pw", code: "123456", recoveryCode: "abcdefghijklmnop" }),
    ).toBe(false);
  });

  it("takes password plus code, a recovery code or a passkey answer", () => {
    expect(ok(Reauth, { password: "pw", code: "123456" })).toBe(true);
    expect(ok(Reauth, { challengeId: passkey.challengeId, response: passkey.response })).toBe(true);
    expect(ok(Reauth, { code: "123456" })).toBe(false);
  });

  it("caps the size of a passkey answer", () => {
    const big = { ...passkey.response, response: { clientDataJSON: "x".repeat(17_000) } };
    expect(ok(WebAuthnResponse, passkey.response)).toBe(true);
    expect(ok(WebAuthnResponse, big)).toBe(false);
  });
});

describe("account changes", () => {
  it("needs at least one field and a known color", () => {
    expect(ok(UpdateAccount, {})).toBe(false);
    expect(ok(UpdateAccount, { color: "#4C9AFF" })).toBe(true);
    expect(ok(UpdateAccount, { color: "#123456" })).toBe(false);
    expect(ConfirmUsername.parse({ confirmUsername: " Anna " })).toEqual({ confirmUsername: "anna" });
  });
});

describe("otpauthUri", () => {
  it("builds the key URI with issuer, encoded label and the fixed parameters", () => {
    const uri = otpauthUri(SECRET, "anna.m");
    expect(uri).toBe(
      `otpauth://totp/Sloppanizer:anna.m?secret=${SECRET}&issuer=Sloppanizer&algorithm=SHA1&digits=6&period=30`,
    );
    expect(otpauthUri(SECRET, "a b", "My Org")).toMatch(/^otpauth:\/\/totp\/My%20Org:a%20b\?/);
  });
});
