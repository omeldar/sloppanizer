import { z } from "zod";
import { isValidTimeZone } from "./dates.ts";
import { DateFormat, Region, TimeFormat } from "./formats.ts";
import { CalendarDate, Id, PROJECT_COLORS, Timestamp } from "./primitives.ts";

/**
 * Accounts, sign-in and the admin dashboard. Every account signs in with a password plus an authenticator
 * code, with a passkey, or both. A password account always has an authenticator too (no password-only
 * accounts). Recovery codes stand in for the authenticator (or, for a passkey-only account, for the
 * passkey); the admin's reset covers the rest.
 */

export const PRODUCT_NAME = "Sloppanizer";

// ---------------------------------------------------------------------------------------------------------
// Fields

/** Names that would read like the system in history lines and URLs. */
export const RESERVED_USERNAMES = ["you", "system", "admin-cli", "api", "u"] as const;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,31}$/;

/** Stored lowercase, fixed after sign-up: it is in URLs and in the browser's account list. */
export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    USERNAME_PATTERN,
    "Use 3 to 32 lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit.",
  )
  .refine(
    (name) => !(RESERVED_USERNAMES as readonly string[]).includes(name),
    "That username is reserved. Pick another.",
  );

export const DisplayName = z
  .string()
  .trim()
  .min(1, "Enter a display name.")
  .max(60, "Keep the display name at 60 characters or fewer.");

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 200;

/**
 * Why a new password is not good enough, or null. The server additionally refuses the most common
 * passwords (its list is not shipped to browsers).
 */
export function passwordProblem(password: string, username?: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if ([...password].every((char) => char === password[0])) return "Use more than one repeated character.";
  if (username && username.length > 0 && password.toLowerCase().includes(username.toLowerCase())) {
    return "The password must not contain the username.";
  }
  return null;
}

/** A new password (sign-up, setup, reset, change). The username rule is checked on the whole object. */
export const Password = z.string().superRefine((value, ctx) => {
  const problem = passwordProblem(value);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/** A password typed to sign in: no strength rules (they may change), only a size cap. */
const LoginPassword = z.string().min(1, "Enter your password.").max(PASSWORD_MAX);

/** 160 bits in base32, made by the client with crypto.getRandomValues. */
export const TotpSecret = z
  .string()
  .regex(/^[A-Z2-7]{32}$/, "The authenticator secret must be 32 base32 characters.");

/** Six digits; spaces are removed. */
export const TotpCode = z
  .string()
  .transform((value) => value.replace(/\s+/g, ""))
  .pipe(z.string().regex(/^\d{6}$/, "Enter the 6 digit code from your authenticator app."));

const RECOVERY_PATTERN = /^[a-z2-7]{4}-?[a-z2-7]{4}-?[a-z2-7]{4}-?[a-z2-7]{4}$/;

/** `abcd-efgh-ijkl-mnop` from any spelling with or without dashes and spaces, in any case. */
export function normalizeRecoveryCode(code: string): string {
  const raw = code.toLowerCase().replace(/[\s-]+/g, "");
  return raw.match(/.{1,4}/g)?.join("-") ?? "";
}

/** 16 base32 characters (80 bits), dashes optional. Normalized to `abcd-efgh-ijkl-mnop`. */
export const RecoveryCode = z
  .string()
  .transform((value) => value.trim().toLowerCase().replace(/\s+/g, ""))
  .pipe(z.string().regex(RECOVERY_PATTERN, "Enter a recovery code like abcd-efgh-ijkl-mnop."))
  .transform(normalizeRecoveryCode);

/** Setup and reset codes as typed: 20 random base32 characters in groups of 4 (or a longer env value). */
const OneTimeCode = z.string().trim().min(20, "Enter the whole code.").max(64, "That code is too long.");
export const SetupCode = OneTimeCode;
export const ResetCode = OneTimeCode;

/** Setup and reset codes compare without case, spaces and dashes. */
export const normalizeOneTimeCode = (code: string): string => code.toUpperCase().replace(/[\s-]+/g, "");

export const AccountColor = z.enum(PROJECT_COLORS);
export type AccountColor = z.infer<typeof AccountColor>;

export const TimeZone = z.string().refine(isValidTimeZone, "Use a time zone name like Europe/Zurich.");

export const ACCOUNT_ROLES = ["user", "admin"] as const;
export const AccountRole = z.enum(ACCOUNT_ROLES);
export type AccountRole = z.infer<typeof AccountRole>;

/** "space": the hidden account of a shared project (never signs in). */
export const ACCOUNT_KINDS = ["user", "space"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const ACCOUNT_STATUSES = ["pending", "active", "disabled"] as const;
export const AccountStatus = z.enum(ACCOUNT_STATUSES);
export type AccountStatus = z.infer<typeof AccountStatus>;

/** "oidc": signed in at auth.omeldar.com ("Sign in with omeldar"). */
export const SESSION_METHODS = ["password", "recovery", "passkey", "setup", "oidc"] as const;
export const SessionMethod = z.enum(SESSION_METHODS);
export type SessionMethod = z.infer<typeof SessionMethod>;

export const REVOKE_REASONS = [
  "logout",
  "other_logout",
  "password_changed",
  "reset",
  "disabled",
  "refresh_reuse",
  "limit",
  "deleted",
] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

export const ADMIN_ACTIONS = [
  "signup",
  "approve",
  "reject",
  "disable",
  "enable",
  "reset_login",
  "unlock",
  "delete",
  "expire_signup",
  "backup",
  "setup_admin",
  "make_admin",
  "move_signin",
] as const;
export const AdminAction = z.enum(ADMIN_ACTIONS);
export type AdminAction = z.infer<typeof AdminAction>;

export const RECOVERY_CODE_COUNT = 10;
export const MAX_PASSKEYS = 10;
export const MAX_SESSIONS = 20;
export const SIGNUP_NOTE_MAX = 300;

/** Id of a server-side WebAuthn challenge (5 minutes, single use). */
export const ChallengeId = z.string().regex(/^[0-9a-f]{32}$/, "Unknown or expired challenge.");

const WEBAUTHN_RESPONSE_MAX = 16 * 1024;

/**
 * A browser's RegistrationResponseJSON or AuthenticationResponseJSON. The WebAuthn library checks the
 * contents; here only the outer shape and the size.
 */
export const WebAuthnResponse = z
  .looseObject({
    id: z.string().min(1).max(1400),
    rawId: z.string().min(1).max(1400),
    type: z.literal("public-key"),
    response: z.looseObject({ clientDataJSON: z.string().min(1) }),
  })
  .refine(
    (value) => JSON.stringify(value).length <= WEBAUTHN_RESPONSE_MAX,
    "The passkey answer is too large.",
  );

export const PasskeyName = z
  .string()
  .trim()
  .min(1, "Give the passkey a name.")
  .max(60, "Keep the name at 60 characters or fewer.");

/** A passkey made in the browser for a registration challenge. */
export const NewPasskey = z.strictObject({
  challengeId: ChallengeId,
  response: WebAuthnResponse,
  name: PasskeyName,
});
export type NewPasskey = z.infer<typeof NewPasskey>;

// ---------------------------------------------------------------------------------------------------------
// Inputs

/** Adds an issue when the password contains the username. */
function checkPasswordName(value: { username: string; password: string }, ctx: z.RefinementCtx): void {
  const problem = passwordProblem(value.password, value.username);
  if (problem) ctx.addIssue({ code: "custom", path: ["password"], message: problem });
}

/** The two ways to set up sign-in: password plus authenticator, or a passkey. */
const passwordFactors = { password: Password, totpSecret: TotpSecret, totpCode: TotpCode };
const passkeyFactor = { passkey: NewPasskey };

const signupBase = {
  username: Username,
  displayName: DisplayName,
  note: z
    .string()
    .trim()
    .max(SIGNUP_NOTE_MAX, `Keep the note at ${SIGNUP_NOTE_MAX} characters or fewer.`)
    .optional(),
  timeZone: TimeZone,
  /** Presets the date and time formats (Switzerland when left out). */
  region: Region.optional(),
};

export const Signup = z.union([
  z.strictObject({ ...signupBase, ...passwordFactors }).superRefine(checkPasswordName),
  z.strictObject({ ...signupBase, ...passkeyFactor }),
]);
export type Signup = z.infer<typeof Signup>;

/** Registration options for a passkey sign-up (before the account exists). */
export const SignupPasskeyOptions = z.strictObject({ username: Username, displayName: DisplayName });
export type SignupPasskeyOptions = z.infer<typeof SignupPasskeyOptions>;

const setupBase = {
  setupCode: SetupCode,
  username: Username,
  displayName: DisplayName,
  timeZone: TimeZone,
  region: Region.optional(),
};

export const Setup = z.union([
  z.strictObject({ ...setupBase, ...passwordFactors }).superRefine(checkPasswordName),
  z.strictObject({ ...setupBase, ...passkeyFactor }),
]);
export type Setup = z.infer<typeof Setup>;

export const SetupPasskeyOptions = z.strictObject({
  setupCode: SetupCode,
  username: Username,
  displayName: DisplayName,
});
export type SetupPasskeyOptions = z.infer<typeof SetupPasskeyOptions>;

/**
 * Password plus authenticator code, password plus recovery code, or (accounts without a password) a
 * recovery code alone. Usernames are normalized like at sign-up; a wrong one simply does not match.
 */
export const Login = z.union([
  z.strictObject({
    username: z.string().trim().toLowerCase().max(64),
    password: LoginPassword,
    code: TotpCode,
  }),
  z.strictObject({
    username: z.string().trim().toLowerCase().max(64),
    password: LoginPassword,
    recoveryCode: RecoveryCode,
  }),
  z.strictObject({ username: z.string().trim().toLowerCase().max(64), recoveryCode: RecoveryCode }),
]);
export type Login = z.infer<typeof Login>;

export const PasskeyLogin = z.strictObject({ challengeId: ChallengeId, response: WebAuthnResponse });
export type PasskeyLogin = z.infer<typeof PasskeyLogin>;

export const Refresh = z.strictObject({ refreshToken: z.string().min(1).max(100) });
export type Refresh = z.infer<typeof Refresh>;

const resetBase = { username: Username, resetCode: ResetCode };

export const ResetLogin = z.union([
  z.strictObject({ ...resetBase, ...passwordFactors }).superRefine(checkPasswordName),
  z.strictObject({ ...resetBase, ...passkeyFactor }),
]);
export type ResetLogin = z.infer<typeof ResetLogin>;

export const ResetPasskeyOptions = z.strictObject(resetBase);
export type ResetPasskeyOptions = z.infer<typeof ResetPasskeyOptions>;

/** Step-up for sensitive actions: the same factors as a login, without the username. */
export const Reauth = z.union([
  z.strictObject({ password: LoginPassword, code: TotpCode }),
  z.strictObject({ password: LoginPassword, recoveryCode: RecoveryCode }),
  z.strictObject({ recoveryCode: RecoveryCode }),
  z.strictObject({ challengeId: ChallengeId, response: WebAuthnResponse }),
]);
export type Reauth = z.infer<typeof Reauth>;

/** How a project page opens when its address does not say (S5#3): the list or the board. */
export const PROJECT_VIEWS = ["list", "board"] as const;
export const ProjectView = z.enum(PROJECT_VIEWS);
export type ProjectView = z.infer<typeof ProjectView>;

/** First or last name on the account (optional, "" clears it). */
export const AccountName = z.string().trim().max(60, "Keep the name at 60 characters or fewer.");

export const UpdateAccount = z
  .strictObject({
    displayName: DisplayName.optional(),
    firstName: AccountName.optional(),
    lastName: AccountName.optional(),
    dateFormat: DateFormat.optional(),
    timeFormat: TimeFormat.optional(),
    projectView: ProjectView.optional(),
    color: AccountColor.optional(),
    timeZone: TimeZone.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), "Send at least one field to change.");
export type UpdateAccount = z.infer<typeof UpdateAccount>;

/**
 * New password. An account without an authenticator (passkey-only so far) sets one up in the same call:
 * a password never works without a code.
 */
export const ChangePassword = z
  .strictObject({ newPassword: Password, totpSecret: TotpSecret.optional(), totpCode: TotpCode.optional() })
  .refine(
    (value) => (value.totpSecret === undefined) === (value.totpCode === undefined),
    "Send the authenticator secret together with a code from it.",
  );
export type ChangePassword = z.infer<typeof ChangePassword>;

export const ReplaceTotp = z.strictObject({ totpSecret: TotpSecret, totpCode: TotpCode });
export type ReplaceTotp = z.infer<typeof ReplaceTotp>;

export const RegisterPasskey = NewPasskey;
export type RegisterPasskey = NewPasskey;

export const RenamePasskey = z.strictObject({ name: PasskeyName });
export type RenamePasskey = z.infer<typeof RenamePasskey>;

/** Typing the username confirms a delete. */
export const ConfirmUsername = z.strictObject({ confirmUsername: z.string().trim().toLowerCase().max(64) });
export type ConfirmUsername = z.infer<typeof ConfirmUsername>;

export const PasskeyIdParams = z.strictObject({ id: z.string().regex(/^[A-Za-z0-9_-]{1,1400}$/) });
export const SessionIdParams = z.strictObject({ id: z.string().regex(/^[0-9a-f]{32}$/) });
export const AdminAccountsQuery = z.strictObject({ status: AccountStatus.optional() });
export type AdminAccountsQuery = z.infer<typeof AdminAccountsQuery>;

// ---------------------------------------------------------------------------------------------------------
// Outputs

const Count = z.number().int().nonnegative();

export const AccountBrief = z.strictObject({
  id: Id,
  username: z.string(),
  displayName: z.string(),
  color: AccountColor,
  role: AccountRole,
});
export type AccountBrief = z.infer<typeof AccountBrief>;

export const SessionTokens = z.strictObject({
  /** 15 minutes; keep it in memory only. */
  accessToken: z.string(),
  accessExpiresAt: Timestamp,
  /** Rotates on every refresh. */
  refreshToken: z.string(),
  sessionId: z.string(),
  account: AccountBrief,
  /** Set when a recovery code was used to sign in: how many are left. */
  recoveryCodesLeft: Count.nullable(),
});
export type SessionTokens = z.infer<typeof SessionTokens>;

export const RecoveryCodes = z.strictObject({
  recoveryCodes: z.array(z.string()).length(RECOVERY_CODE_COUNT),
});
export type RecoveryCodes = z.infer<typeof RecoveryCodes>;

export const SignupResult = z.strictObject({
  status: z.literal("pending"),
  recoveryCodes: RecoveryCodes.shape.recoveryCodes,
});
export type SignupResult = z.infer<typeof SignupResult>;

export const SetupResult = z.strictObject({
  recoveryCodes: RecoveryCodes.shape.recoveryCodes,
  session: SessionTokens,
});
export type SetupResult = z.infer<typeof SetupResult>;

/**
 * How people sign in (SLOPPANIZER_AUTH): "local" Sloppanizer's own login only, "both" the own login and
 * "Sign in with omeldar", "oidc" only omeldar (auth.omeldar.com).
 */
export const AUTH_MODES = ["local", "both", "oidc"] as const;
export const AuthMode = z.enum(AUTH_MODES);
export type AuthMode = z.infer<typeof AuthMode>;

export const AuthConfig = z.strictObject({
  signupsOpen: z.boolean(),
  setupNeeded: z.boolean(),
  rpId: z.string(),
  mode: AuthMode,
  /** What the web app needs to start "Sign in with omeldar" (null in "local" mode). */
  omeldar: z
    .strictObject({
      issuer: z.string(),
      clientId: z.string(),
      redirectUri: z.string(),
      /** "Manage account" at auth.omeldar.com. */
      accountUrl: z.string(),
    })
    .nullable(),
  /**
   * When Sloppanizer's own login stops (SLOPPANIZER_LOCAL_LOGIN_UNTIL, "both" only): the day, and the
   * instant it starts. Null or missing (a server from before it): no end.
   */
  localLoginEnds: z.strictObject({ on: CalendarDate, at: Timestamp }).nullable().optional(),
});
export type AuthConfig = z.infer<typeof AuthConfig>;

/** options = PublicKeyCredentialCreationOptionsJSON or PublicKeyCredentialRequestOptionsJSON. */
export const ChallengeOptions = z.strictObject({
  challengeId: z.string(),
  options: z.record(z.string(), z.unknown()),
});
export type ChallengeOptions = z.infer<typeof ChallengeOptions>;

export const AccountProfile = z.strictObject({
  ...AccountBrief.shape,
  firstName: z.string(),
  lastName: z.string(),
  dateFormat: DateFormat,
  timeFormat: TimeFormat,
  /** How project pages open (Settings, Projects). */
  projectView: ProjectView,
  /** Signed in through auth.omeldar.com at least once (it confirms "it is you" there). */
  omeldarLinked: z.boolean(),
  timeZone: z.string(),
  createdAt: Timestamp,
  security: z.strictObject({
    /** Whether the account has a password (always together with an authenticator). */
    password: z.boolean(),
    passwordChangedAt: Timestamp.nullable(),
    totpSince: Timestamp.nullable(),
    passkeys: Count,
    recoveryCodesLeft: Count,
    /** Last admin reset of the login; API tokens made before it deserve a look ("Check your API tokens."). */
    loginResetAt: Timestamp.nullable(),
  }),
});
export type AccountProfile = z.infer<typeof AccountProfile>;

export const Passkey = z.strictObject({
  id: z.string(),
  name: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp.nullable(),
  /** Synced by the platform (iCloud Keychain, Google Password Manager ...). */
  backedUp: z.boolean(),
  deviceType: z.enum(["singleDevice", "multiDevice"]),
});
export type Passkey = z.infer<typeof Passkey>;

export const SessionInfo = z.strictObject({
  id: z.string(),
  current: z.boolean(),
  method: SessionMethod,
  /** e.g. "Chrome on Windows", parsed from the user agent by the server. */
  device: z.string(),
  createdAt: Timestamp,
  lastUsedAt: Timestamp,
  expiresAt: Timestamp,
  ip: z.string().nullable(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const RevokedSessions = z.strictObject({ revoked: Count });
export type RevokedSessions = z.infer<typeof RevokedSessions>;

export const AdminSignup = z.strictObject({
  id: Id,
  username: z.string(),
  displayName: z.string(),
  note: z.string(),
  createdAt: Timestamp,
  expiresAt: Timestamp,
});
export type AdminSignup = z.infer<typeof AdminSignup>;

export const AdminAccount = z.strictObject({
  id: Id,
  username: z.string(),
  displayName: z.string(),
  role: AccountRole,
  status: AccountStatus,
  createdAt: Timestamp,
  approvedAt: Timestamp.nullable(),
  lastLoginAt: Timestamp.nullable(),
  lockedUntil: Timestamp.nullable(),
  activeSessions: Count,
  methods: z.strictObject({ password: z.boolean(), totp: z.boolean(), passkeys: Count }),
  filesBytes: Count,
  resetPending: z.boolean(),
});
export type AdminAccount = z.infer<typeof AdminAccount>;

export const ResetCodeResult = z.strictObject({ resetCode: z.string(), expiresAt: Timestamp });
export type ResetCodeResult = z.infer<typeof ResetCodeResult>;

export const AdminEvent = z.strictObject({
  id: Id,
  at: Timestamp,
  actor: z.string(),
  action: AdminAction,
  target: z.string().nullable(),
});
export type AdminEvent = z.infer<typeof AdminEvent>;

/** One whole-instance backup zip (it stays on the server; the dashboard shows only this). */
export const InstanceBackup = z.strictObject({ fileName: z.string(), createdAt: Timestamp, bytes: Count });
export type InstanceBackup = z.infer<typeof InstanceBackup>;

export const InstanceInfo = z.strictObject({
  version: z.string(),
  schemaVersion: Count,
  accounts: z.strictObject({ pending: Count, active: Count, disabled: Count }),
  dbBytes: Count,
  filesBytes: Count,
  backups: z.strictObject({
    lastAt: Timestamp.nullable(),
    nextAt: Timestamp.nullable(),
    keep: Count,
    files: z.array(InstanceBackup),
  }),
});
export type InstanceInfo = z.infer<typeof InstanceInfo>;

// ---------------------------------------------------------------------------------------------------------
// Pure helpers

/** The otpauth:// URI an authenticator app reads from the QR code. */
export function otpauthUri(secret: string, username: string, issuer = PRODUCT_NAME): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(username)}`;
  const query = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** What the browser kept between starting "Sign in with omeldar" and the callback (omeldar-auth Pending). */
export const OidcPending = z.strictObject({
  state: z.string().min(8).max(200),
  nonce: z.string().min(8).max(200),
  verifier: z.string().min(43).max(200),
  maxAge: z.number().int().min(0).max(86_400).optional(),
});
export type OidcPending = z.infer<typeof OidcPending>;

/** The callback's query string (?code=...&state=...) and the pending sign-in, sent by the web app. */
export const OidcCallback = z.strictObject({
  query: z.string().max(4096),
  pending: OidcPending,
  /** The browser's time zone, for an account made by this sign-in. */
  timeZone: TimeZone.optional(),
});
export type OidcCallback = z.infer<typeof OidcCallback>;

/** Confirming it is you through auth.omeldar.com (a fresh sign-in there). */
export const OidcReauth = z.strictObject({ query: z.string().max(4096), pending: OidcPending });
export type OidcReauth = z.infer<typeof OidcReauth>;
