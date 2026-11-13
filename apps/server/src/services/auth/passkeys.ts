import { MAX_PASSKEYS, type Passkey } from "@organizer/shared";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { and, asc, eq } from "drizzle-orm";
import { passkeys } from "../../db/auth-schema.ts";
import { ApiError } from "../../http/errors.ts";
import type { Tx } from "../context.ts";
import type { AuthServices } from "./index.ts";

/**
 * Passkeys (WebAuthn) through @simplewebauthn/server: discoverable credentials, user verification
 * required, no attestation. The challenge store keeps each challenge 5 minutes, single use.
 */

export type PasskeyRow = typeof passkeys.$inferSelect;

export const toPasskey = (row: PasskeyRow): Passkey => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt,
  lastUsedAt: row.lastUsedAt,
  backedUp: row.backedUp,
  deviceType: row.deviceType,
});

export const listPasskeyRows = (tx: Tx, accountId: number): PasskeyRow[] =>
  tx.select().from(passkeys).where(eq(passkeys.accountId, accountId)).orderBy(asc(passkeys.createdAt)).all();

export const countPasskeys = (tx: Tx, accountId: number): number => listPasskeyRows(tx, accountId).length;

export const findPasskey = (tx: Tx, accountId: number, id: string): PasskeyRow | undefined =>
  tx
    .select()
    .from(passkeys)
    .where(and(eq(passkeys.id, id), eq(passkeys.accountId, accountId)))
    .get();

const transportsOf = (row: PasskeyRow): string[] => {
  try {
    const value: unknown = JSON.parse(row.transports);
    return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
};

export interface RegistrationUser {
  username: string;
  displayName: string;
  /** base64url WebAuthn user handle. */
  webauthnUserId: string;
}

/** Options for navigator.credentials.create; existing passkeys are excluded (no double registration). */
export async function registrationOptions(
  auth: AuthServices,
  user: RegistrationUser,
  existing: PasskeyRow[],
): Promise<{ challenge: string; options: Record<string, unknown> }> {
  const options = await generateRegistrationOptions({
    rpName: auth.config.rpName,
    rpID: auth.config.rpId,
    userName: user.username,
    userDisplayName: user.displayName,
    userID: Buffer.from(user.webauthnUserId, "base64url"),
    attestationType: "none",
    excludeCredentials: existing.map((row) => ({ id: row.id, transports: transportsOf(row) })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    timeout: 300_000,
  });
  return { challenge: options.challenge, options: options as unknown as Record<string, unknown> };
}

/** Options for navigator.credentials.get: discoverable (no list) for a login, the account's for a reauth. */
export async function authenticationOptions(
  auth: AuthServices,
  allow: PasskeyRow[] | null,
): Promise<{ challenge: string; options: Record<string, unknown> }> {
  const options = await generateAuthenticationOptions({
    rpID: auth.config.rpId,
    userVerification: "required",
    allowCredentials: (allow ?? []).map((row) => ({ id: row.id, transports: transportsOf(row) })),
    timeout: 300_000,
  });
  return { challenge: options.challenge, options: options as unknown as Record<string, unknown> };
}

const PASSKEY_FAILED = "The passkey did not work. Try again.";

/** The verified new credential, ready to insert. Throws 422 when the browser's answer does not verify. */
export async function verifyRegistration(
  auth: AuthServices,
  challenge: string,
  response: unknown,
): Promise<Omit<PasskeyRow, "accountId" | "name" | "createdAt" | "lastUsedAt">> {
  let result;
  try {
    result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: auth.config.webOrigins,
      expectedRPID: auth.config.rpId,
      requireUserVerification: true,
    });
  } catch {
    throw new ApiError("validation_failed", PASSKEY_FAILED);
  }
  if (!result.verified) throw new ApiError("validation_failed", PASSKEY_FAILED);
  const info = result.registrationInfo;
  return {
    id: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey),
    counter: info.credential.counter,
    transports: JSON.stringify(info.credential.transports ?? []),
    deviceType: info.credentialDeviceType,
    backedUp: info.credentialBackedUp,
    aaguid: info.aaguid,
  };
}

/** Stores a verified passkey (max 10 per account; a credential id is known only once). */
export function insertPasskey(
  tx: Tx,
  accountId: number,
  nowIso: string,
  name: string,
  verified: Awaited<ReturnType<typeof verifyRegistration>>,
): PasskeyRow {
  if (countPasskeys(tx, accountId) >= MAX_PASSKEYS) {
    throw new ApiError(
      "conflict",
      `This account has ${MAX_PASSKEYS} passkeys, the most it can have. Remove one you no longer use.`,
    );
  }
  if (tx.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.id, verified.id)).get()) {
    throw new ApiError("conflict", "This passkey is registered already.");
  }
  return tx
    .insert(passkeys)
    .values({ ...verified, accountId, name, createdAt: nowIso })
    .returning()
    .get();
}

export type AssertionOutcome =
  | { ok: true; row: PasskeyRow; newCounter: number }
  | { ok: false; reason: "unknown" | "failed" | "counter" };

/**
 * Checks a sign-in answer against the stored credential. A counter that went backwards (and is not 0,
 * which authenticators without a counter send) is refused: a sign of a cloned authenticator.
 */
export async function verifyAssertion(
  auth: AuthServices,
  tx: Tx,
  challenge: string,
  response: { id: string; response?: unknown },
  accountId?: number,
): Promise<AssertionOutcome> {
  const row = tx.select().from(passkeys).where(eq(passkeys.id, response.id)).get();
  if (!row || (accountId !== undefined && row.accountId !== accountId))
    return { ok: false, reason: "unknown" };
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: auth.config.webOrigins,
      expectedRPID: auth.config.rpId,
      requireUserVerification: true,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.publicKey),
        counter: row.counter,
        transports: transportsOf(row) as never,
      },
    });
  } catch (error) {
    const counter = /counter/i.test((error as Error).message);
    return { ok: false, reason: counter ? "counter" : "failed" };
  }
  if (!result.verified) return { ok: false, reason: "failed" };
  return { ok: true, row, newCounter: result.authenticationInfo.newCounter };
}

export function markPasskeyUsed(tx: Tx, id: string, counter: number, nowIso: string): void {
  tx.update(passkeys).set({ counter, lastUsedAt: nowIso }).where(eq(passkeys.id, id)).run();
}

export function renamePasskey(tx: Tx, accountId: number, id: string, name: string): PasskeyRow | undefined {
  return tx
    .update(passkeys)
    .set({ name })
    .where(and(eq(passkeys.id, id), eq(passkeys.accountId, accountId)))
    .returning()
    .get();
}

export function deletePasskey(tx: Tx, accountId: number, id: string): boolean {
  return (
    tx
      .delete(passkeys)
      .where(and(eq(passkeys.id, id), eq(passkeys.accountId, accountId)))
      .run().changes > 0
  );
}
