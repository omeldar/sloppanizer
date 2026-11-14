import { ACCOUNT_ROLES, ACCOUNT_STATUSES, REVOKE_REASONS, SESSION_METHODS } from "@organizer/shared";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Accounts and sign-in. User data lives in schema.ts, every row there points at accounts.id.
 * Secrets are never stored in the clear: passwords as argon2id PHC strings, the authenticator secret
 * encrypted with the data key (services/auth/crypto.ts), recovery, setup and reset codes and refresh
 * tokens as sha256 hex.
 */

const inList = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    /** Lowercase, fixed after sign-up. */
    username: text("username").notNull().unique(),
    displayName: text("display_name").notNull(),
    color: text("color").notNull().default("#8B95A5"),
    timeZone: text("time_zone").notNull(),
    role: text("role", { enum: ACCOUNT_ROLES }).notNull().default("user"),
    status: text("status", { enum: ACCOUNT_STATUSES }).notNull(),
    signupNote: text("signup_note").notNull().default(""),
    /** NULL: passkey-only account, or an admin reset is open. */
    passwordHash: text("password_hash"),
    passwordChangedAt: text("password_changed_at"),
    /** `v1:<iv>:<ciphertext>:<tag>`; NULL without an authenticator. */
    totpSecretEnc: text("totp_secret_enc"),
    /** Highest accepted 30 s step (replay guard). */
    totpLastStep: integer("totp_last_step"),
    totpSince: text("totp_since"),
    /** 32 random bytes base64url: the WebAuthn user handle, never the account id. */
    webauthnUserId: text("webauthn_user_id").notNull().unique(),
    resetCodeHash: text("reset_code_hash"),
    resetExpiresAt: text("reset_expires_at"),
    /** Last admin reset of the login (the security page asks to check API tokens made before it). */
    loginResetAt: text("login_reset_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    approvedAt: text("approved_at"),
    approvedBy: integer("approved_by").references((): AnySQLiteColumn => accounts.id, {
      onDelete: "set null",
    }),
    disabledAt: text("disabled_at"),
    lastLoginAt: text("last_login_at"),
  },
  (t) => [
    index("accounts_status_idx").on(t.status),
    check("accounts_role_check", sql`${t.role} IN (${inList(ACCOUNT_ROLES)})`),
    check("accounts_status_check", sql`${t.status} IN (${inList(ACCOUNT_STATUSES)})`),
  ],
);

/** Ten per account; each works once. A new set replaces the old one. */
export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** sha256 hex of the normalized code. */
    codeHash: text("code_hash").notNull(),
    createdAt: text("created_at").notNull(),
    usedAt: text("used_at"),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.codeHash] })],
);

export const passkeys = sqliteTable(
  "passkeys",
  {
    /** Credential id, base64url. */
    id: text("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    publicKey: blob("public_key", { mode: "buffer" }).notNull(),
    counter: integer("counter").notNull(),
    /** JSON array of AuthenticatorTransport. */
    transports: text("transports").notNull().default("[]"),
    deviceType: text("device_type", { enum: ["singleDevice", "multiDevice"] }).notNull(),
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    aaguid: text("aaguid").notNull().default(""),
    name: text("name").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (t) => [index("passkeys_account_idx").on(t.accountId)],
);

/** A signed-in browser. Access tokens name the session; every request checks it is still live. */
export const sessions = sqliteTable(
  "sessions",
  {
    /** 16 random bytes hex. */
    id: text("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    refreshHash: text("refresh_hash").notNull().unique(),
    /** The refresh token before the last rotation (60 s grace for a lost answer or two racing tabs). */
    prevRefreshHash: text("prev_refresh_hash"),
    rotatedAt: text("rotated_at"),
    method: text("method", { enum: SESSION_METHODS }).notNull(),
    /** Last full login or reauth (sensitive actions need it within 10 minutes). */
    authenticatedAt: text("authenticated_at").notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    revokeReason: text("revoke_reason", { enum: REVOKE_REASONS }),
    userAgent: text("user_agent").notNull().default(""),
    ip: text("ip"),
  },
  (t) => [
    index("sessions_account_idx").on(t.accountId, t.revokedAt),
    check("sessions_method_check", sql`${t.method} IN (${inList(SESSION_METHODS)})`),
    check(
      "sessions_revoke_reason_check",
      sql`${t.revokeReason} IS NULL OR ${t.revokeReason} IN (${inList(REVOKE_REASONS)})`,
    ),
  ],
);

/**
 * Failed logins per typed username, also for names that do not exist (a lock says nothing about which
 * names exist). In the database so a restart does not reset a lock.
 */
export const loginThrottle = sqliteTable("login_throttle", {
  nameKey: text("name_key").primaryKey(),
  failures: integer("failures").notNull(),
  lockedUntil: text("locked_until"),
  lastFailureAt: text("last_failure_at").notNull(),
});

/** What admins (and the CLI and the system) did to accounts. Metadata only, never account contents. */
export const adminEvents = sqliteTable(
  "admin_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    at: text("at").notNull(),
    /** Admin username, "cli" or "system". */
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    /** Username the action was about. */
    target: text("target"),
    /** JSON metadata. */
    data: text("data").notNull().default("{}"),
  },
  (t) => [index("admin_events_at_idx").on(t.at)],
);

/** Instance-wide values (JSON): setupCodeHash, lastBackup. */
export const instanceSettings = sqliteTable("instance_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/**
 * OAuth clients (dynamic client registration, RFC 7591): MCP clients like claude.ai register themselves.
 * Public clients only (PKCE, no secret).
 */
export const oauthClients = sqliteTable("oauth_clients", {
  /** The client_id: 24 random bytes base64url. */
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** JSON array of the exact redirect URIs. */
  redirectUris: text("redirect_uris").notNull(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

/**
 * One account's consent to one client. Its access token is an API token of the account (token_id, so
 * it shows on the tokens page and revoking it ends the grant); the refresh token is stored as sha256.
 */
export const oauthGrants = sqliteTable(
  "oauth_grants",
  {
    id: integer("id").primaryKey(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    tokenId: integer("token_id").notNull(),
    refreshHash: text("refresh_hash").notNull().unique(),
    scope: text("scope", { enum: ["read", "write"] }).notNull(),
    createdAt: text("created_at").notNull(),
    refreshedAt: text("refreshed_at"),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    index("oauth_grants_account_idx").on(t.accountId, t.clientId),
    check("oauth_grants_scope_check", sql`${t.scope} IN ('read','write')`),
  ],
);
