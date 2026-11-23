-- sessions is rebuilt for the new "oidc" method in its CHECK (no table references sessions, so the drop
-- cascades nowhere); accounts only gets a column (dropping it would cascade into every account's data).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`refresh_hash` text NOT NULL,
	`prev_refresh_hash` text,
	`rotated_at` text,
	`method` text NOT NULL,
	`authenticated_at` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`revoke_reason` text,
	`user_agent` text DEFAULT '' NOT NULL,
	`ip` text,
	`auth_sid` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_method_check" CHECK("__new_sessions"."method" IN ('password','recovery','passkey','setup','oidc')),
	CONSTRAINT "sessions_revoke_reason_check" CHECK("__new_sessions"."revoke_reason" IS NULL OR "__new_sessions"."revoke_reason" IN ('logout','other_logout','password_changed','reset','disabled','refresh_reuse','limit','deleted'))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "account_id", "refresh_hash", "prev_refresh_hash", "rotated_at", "method", "authenticated_at", "created_at", "last_used_at", "expires_at", "revoked_at", "revoke_reason", "user_agent", "ip", "auth_sid") SELECT "id", "account_id", "refresh_hash", "prev_refresh_hash", "rotated_at", "method", "authenticated_at", "created_at", "last_used_at", "expires_at", "revoked_at", "revoke_reason", "user_agent", "ip", NULL FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_refresh_hash_unique` ON `sessions` (`refresh_hash`);--> statement-breakpoint
CREATE INDEX `sessions_account_idx` ON `sessions` (`account_id`,`revoked_at`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `auth_subject` text;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_auth_subject_unique` ON `accounts` (`auth_subject`);