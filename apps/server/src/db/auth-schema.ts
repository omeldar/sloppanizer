import {
  ACCOUNT_KINDS,
  ACCOUNT_ROLES,
  ACCOUNT_STATUSES,
  REVOKE_REASONS,
  SESSION_METHODS,
  SPACE_ROLES,
} from "@organizer/shared";
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
    /** Optional real name; feedback and shared projects show "First Last" when set, else the username. */
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    /**
     * "user": a person who signs in. "space": the hidden owner of a shared project's data (services/spaces.ts);
     * it never signs in (its username starts with "~", which no sign-in form accepts).
     */
    kind: text("kind", { enum: ACCOUNT_KINDS }).notNull().default("user"),
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
    check("accounts_kind_check", sql`${t.kind} IN (${inList(ACCOUNT_KINDS)})`),
  ],
);

/**
 * Shared projects. Each one is a space account (accounts.kind = "space") holding the project's data;
 * members open it in the web app under /u/<username>/shared/<space id> and every request carries the
 * X-Sloppanizer-Space header (http/security.ts). system_key "feedback" marks the Sloppanizer project
 * that bug reports and feature requests go to: its members are all admins (not stored).
 */
export const spaces = sqliteTable("spaces", {
  accountId: integer("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  systemKey: text("system_key").unique(),
  createdBy: integer("created_by").references(() => accounts.id, { onDelete: "set null" }),
  createdAt: text("created_at").notNull(),
});

export const spaceMembers = sqliteTable(
  "space_members",
  {
    spaceId: integer("space_id")
      .notNull()
      .references(() => spaces.accountId, { onDelete: "cascade" }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    role: text("role", { enum: SPACE_ROLES }).notNull(),
    addedAt: text("added_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.accountId] }),
    index("space_members_account_idx").on(t.accountId),
    check("space_members_role_check", sql`${t.role} IN (${inList(SPACE_ROLES)})`),
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

/**
 * The account's calendar feed: a secret link (stored as sha256) that calendar apps poll for the planner's
 * time blocks. One per account; resetting it replaces the secret.
 */
export const calendarFeeds = sqliteTable("calendar_feeds", {
  accountId: integer("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at").notNull(),
  lastUsedAt: text("last_used_at"),
});

/**
 * The account's AI assistant: which provider, its models and the working day the planner fills. The
 * Claude API key is encrypted with the data key (purpose "ai-claude-key"); this table is never exported.
 */
export const aiSettings = sqliteTable("ai_settings", {
  accountId: integer("account_id")
    .primaryKey()
    .references(() => accounts.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["none", "claude", "ollama"] })
    .notNull()
    .default("none"),
  claudeModel: text("claude_model").notNull().default("claude-opus-5-5"),
  claudeKeyEnc: text("claude_key_enc"),
  ollamaUrl: text("ollama_url").notNull().default("http://localhost:11434"),
  ollamaModel: text("ollama_model").notNull().default("jaahas/qwen3.5-uncensored:9b"),
  dayStart: text("day_start").notNull().default("09:00"),
  dayEnd: text("day_end").notNull().default("18:00"),
  updatedAt: text("updated_at").notNull(),
});
