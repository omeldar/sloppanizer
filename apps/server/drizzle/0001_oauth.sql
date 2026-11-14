CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` integer PRIMARY KEY NOT NULL,
	`account_id` integer NOT NULL,
	`client_id` text NOT NULL,
	`token_id` integer NOT NULL,
	`refresh_hash` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL,
	`refreshed_at` text,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "oauth_grants_scope_check" CHECK("oauth_grants"."scope" IN ('read','write'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_refresh_hash_unique` ON `oauth_grants` (`refresh_hash`);--> statement-breakpoint
CREATE INDEX `oauth_grants_account_idx` ON `oauth_grants` (`account_id`,`client_id`);