CREATE TABLE `draw_handoffs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`creator_id` integer NOT NULL,
	`actor` text NOT NULL,
	`token_hash` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`received_at` text,
	`attachment_id` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`creator_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draw_handoffs_token_hash_unique` ON `draw_handoffs` (`token_hash`);--> statement-breakpoint
CREATE INDEX `draw_handoffs_expires_idx` ON `draw_handoffs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `draw_handoffs_creator_idx` ON `draw_handoffs` (`creator_id`);