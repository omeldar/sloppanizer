CREATE TABLE `time_blocks` (
	`account_id` integer NOT NULL,
	`id` integer NOT NULL,
	`todo_id` integer,
	`title` text DEFAULT '' NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`todo_id`) REFERENCES `todos`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "time_blocks_order_check" CHECK("time_blocks"."end_at" > "time_blocks"."start_at"),
	CONSTRAINT "time_blocks_title_check" CHECK(length("time_blocks"."title") <= 200),
	CONSTRAINT "time_blocks_what_check" CHECK("time_blocks"."todo_id" IS NOT NULL OR length("time_blocks"."title") > 0)
);
--> statement-breakpoint
CREATE INDEX `time_blocks_start_idx` ON `time_blocks` (`account_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `time_blocks_todo_idx` ON `time_blocks` (`account_id`,`todo_id`);--> statement-breakpoint
CREATE TABLE `todo_urls` (
	`account_id` integer NOT NULL,
	`id` integer NOT NULL,
	`todo_id` integer NOT NULL,
	`url` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`position` real NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`todo_id`) REFERENCES `todos`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "todo_urls_url_check" CHECK(length("todo_urls"."url") BETWEEN 1 AND 2000),
	CONSTRAINT "todo_urls_label_check" CHECK(length("todo_urls"."label") <= 200)
);
--> statement-breakpoint
CREATE INDEX `todo_urls_todo_idx` ON `todo_urls` (`account_id`,`todo_id`,`position`);