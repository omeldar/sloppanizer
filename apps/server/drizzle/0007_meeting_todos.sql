CREATE TABLE `meeting_todos` (
	`account_id` integer NOT NULL,
	`meeting_id` integer NOT NULL,
	`todo_id` integer NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `meeting_id`, `todo_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`meeting_id`) REFERENCES `meetings`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`todo_id`) REFERENCES `todos`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `meeting_todos_todo_idx` ON `meeting_todos` (`account_id`,`todo_id`);