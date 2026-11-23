CREATE TABLE `space_members` (
	`space_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`role` text NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`space_id`, `account_id`),
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`account_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "space_members_role_check" CHECK("space_members"."role" IN ('owner','member'))
);
--> statement-breakpoint
CREATE INDEX `space_members_account_idx` ON `space_members` (`account_id`);--> statement-breakpoint
CREATE TABLE `spaces` (
	`account_id` integer PRIMARY KEY NOT NULL,
	`system_key` text,
	`created_by` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `spaces_system_key_unique` ON `spaces` (`system_key`);--> statement-breakpoint
-- Hand-written: drizzle-kit rebuilds accounts for a new CHECK, and dropping accounts would cascade into
-- every account's data. ADD COLUMN keeps the rows (SQLite allows a CHECK with a constant default).
ALTER TABLE `accounts` ADD `first_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `last_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `kind` text DEFAULT 'user' NOT NULL CONSTRAINT "accounts_kind_check" CHECK("kind" IN ('user','space'));
