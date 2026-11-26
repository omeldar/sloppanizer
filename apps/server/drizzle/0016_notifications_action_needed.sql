CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipient_id` integer NOT NULL,
	`todo_account_id` integer NOT NULL,
	`todo_id` integer NOT NULL,
	`kind` text NOT NULL,
	`actor` text NOT NULL,
	`excerpt` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text,
	FOREIGN KEY (`recipient_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`todo_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`todo_account_id`,`todo_id`) REFERENCES `todos`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notifications_kind_check" CHECK("notifications"."kind" IN ('assigned','mentioned','commented','action_needed'))
);
--> statement-breakpoint
CREATE INDEX `notifications_recipient_idx` ON `notifications` (`recipient_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_todo_idx` ON `notifications` (`todo_account_id`,`todo_id`);--> statement-breakpoint
ALTER TABLE `todos` ADD `action_needed` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `action_needed_by` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `action_needed_at` text;--> statement-breakpoint
CREATE INDEX `todos_action_needed_idx` ON `todos` (`account_id`,`action_needed_at`);