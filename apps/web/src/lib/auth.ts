import {
  AuthConfig,
  ChallengeOptions,
  type Login,
  RecoveryCodes,
  type ResetLogin,
  SessionTokens,
  type Setup,
  SetupResult,
  type Signup,
  SignupResult,
} from "@organizer/shared";
import { api } from "./api.ts";
import { getPasskey } from "./webauthn.ts";

/** Calls of the auth pages (no account yet) and the passkey steps shared with the account pages. */

export const authConfig = () => api(AuthConfig, "/auth/config");

export const signup = (input: Signup) => api(SignupResult, "/auth/signup", { method: "POST", body: input });

export const setup = (input: Setup) => api(SetupResult, "/auth/setup", { method: "POST", body: input });

export const login = (input: Login) => api(SessionTokens, "/auth/login", { method: "POST", body: input });

export const resetLogin = (input: ResetLogin) =>
  api(RecoveryCodes, "/auth/reset", { method: "POST", body: input });

/** Registration options for a new passkey, per flow (the body says for whom). */
export const passkeyOptions = (path: string, body?: unknown) =>
  api(ChallengeOptions, path, { method: "POST", body: body ?? {} });

/**
 * The passkey login: options from the server, the browser asks for the passkey, the server checks it.
 * Null when the person cancels.
 */
export async function loginWithPasskey(
  options: { conditional?: boolean; signal?: AbortSignal } = {},
): Promise<SessionTokens | null> {
  const challenge = await passkeyOptions("/auth/passkey/options");
  const response = await getPasskey(challenge.options, options);
  if (!response) return null;
  return api(SessionTokens, "/auth/passkey/login", {
    method: "POST",
    body: { challengeId: challenge.challengeId, response },
  });
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** A new authenticator secret: 160 random bits as 32 base32 characters, made in this browser. */
export function newTotpSecret(
  random: (bytes: Uint8Array<ArrayBuffer>) => void = (b) => crypto.getRandomValues(b),
): string {
  const bytes = new Uint8Array(20);
  random(bytes);
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** "ABCD EFGH ..." for reading and typing the secret by hand. */
export const groupsOf4 = (text: string) => text.match(/.{1,4}/g)?.join(" ") ?? "";

/** The recovery codes as a text file to keep. */
export function recoveryCodesText(username: string, codes: readonly string[], now: Date): string {
  return [
    `Sloppanizer recovery codes for ${username}`,
    `Made ${now.toISOString().slice(0, 10)}. Each code works once. Keep them somewhere safe.`,
    "",
    ...codes,
    "",
  ].join("\n");
}

/** The time zone of this browser, for new accounts. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
