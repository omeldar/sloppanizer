-- Drizzle runs every migration in one transaction with foreign keys on: PRAGMA foreign_keys does nothing
-- there, and dropping series would delete the meetings' moved and cancelled dates with it. They wait in a
-- copy while the table is rebuilt.
CREATE TABLE `__keep_series_exceptions` AS SELECT * FROM `series_exceptions`;--> statement-breakpoint
CREATE TABLE `__new_series` (
	`account_id` integer NOT NULL,
	`id` integer NOT NULL,
	`owner_kind` text NOT NULL,
	`meeting_id` integer,
	`todo_id` integer,
	`rule` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text,
	`start_time` text NOT NULL,
	`duration_min` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`meeting_id`) REFERENCES `meetings`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`todo_id`) REFERENCES `todos`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "series_owner_check" CHECK(("__new_series"."owner_kind" = 'meeting' AND "__new_series"."meeting_id" IS NOT NULL AND "__new_series"."todo_id" IS NULL) OR ("__new_series"."owner_kind" = 'todo' AND "__new_series"."todo_id" IS NOT NULL AND "__new_series"."meeting_id" IS NULL)),
	CONSTRAINT "series_rule_check" CHECK(json_valid("__new_series"."rule")),
	CONSTRAINT "series_duration_check" CHECK("__new_series"."duration_min" BETWEEN 5 AND 1440),
	CONSTRAINT "series_dates_check" CHECK("__new_series"."ends_on" IS NULL OR "__new_series"."ends_on" >= "__new_series"."starts_on")
);
--> statement-breakpoint
INSERT INTO `__new_series`("account_id", "id", "owner_kind", "meeting_id", "todo_id", "rule", "starts_on", "ends_on", "start_time", "duration_min", "created_at", "updated_at") SELECT "account_id", "id", "owner_kind", "meeting_id", NULL, "rule", "starts_on", "ends_on", "start_time", "duration_min", "created_at", "updated_at" FROM `series`;--> statement-breakpoint
DROP TABLE `series`;--> statement-breakpoint
ALTER TABLE `__new_series` RENAME TO `series`;--> statement-breakpoint
INSERT INTO `series_exceptions` SELECT * FROM `__keep_series_exceptions`;--> statement-breakpoint
DROP TABLE `__keep_series_exceptions`;--> statement-breakpoint
CREATE INDEX `series_meeting_idx` ON `series` (`account_id`,`meeting_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `series_todo_idx` ON `series` (`account_id`,`todo_id`,`starts_on`);