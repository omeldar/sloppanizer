CREATE TABLE `meeting_notes` (
	`account_id` integer NOT NULL,
	`meeting_id` integer NOT NULL,
	`occurs_on` text NOT NULL,
	`note_id` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `meeting_id`, `occurs_on`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`meeting_id`) REFERENCES `meetings`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`note_id`) REFERENCES `notes`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_notes_note_unique` ON `meeting_notes` (`account_id`,`note_id`);--> statement-breakpoint
CREATE TABLE `meetings` (
	`account_id` integer NOT NULL,
	`id` integer NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'other' NOT NULL,
	`filter` text DEFAULT '{}' NOT NULL,
	`since` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "meetings_name_check" CHECK(length("meetings"."name") BETWEEN 1 AND 200),
	CONSTRAINT "meetings_type_check" CHECK("meetings"."type" IN ('standup','other')),
	CONSTRAINT "meetings_filter_check" CHECK(json_valid("meetings"."filter"))
);
--> statement-breakpoint
CREATE TABLE `series` (
	`account_id` integer NOT NULL,
	`id` integer NOT NULL,
	`owner_kind` text NOT NULL,
	`meeting_id` integer,
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
	CONSTRAINT "series_rule_check" CHECK(json_valid("series"."rule")),
	CONSTRAINT "series_duration_check" CHECK("series"."duration_min" BETWEEN 5 AND 1440),
	CONSTRAINT "series_dates_check" CHECK("series"."ends_on" IS NULL OR "series"."ends_on" >= "series"."starts_on")
);
--> statement-breakpoint
CREATE INDEX `series_meeting_idx` ON `series` (`account_id`,`meeting_id`,`starts_on`);--> statement-breakpoint
CREATE TABLE `series_exceptions` (
	`account_id` integer NOT NULL,
	`series_id` integer NOT NULL,
	`occurs_on` text NOT NULL,
	`kind` text NOT NULL,
	`start_at` text,
	`end_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `series_id`, `occurs_on`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`series_id`) REFERENCES `series`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "series_exceptions_kind_check" CHECK("series_exceptions"."kind" IN ('cancelled','moved')),
	CONSTRAINT "series_exceptions_moved_check" CHECK("series_exceptions"."kind" = 'cancelled' OR ("series_exceptions"."start_at" IS NOT NULL AND "series_exceptions"."end_at" > "series_exceptions"."start_at"))
);
--> statement-breakpoint
CREATE INDEX `series_exceptions_start_idx` ON `series_exceptions` (`account_id`,`start_at`);--> statement-breakpoint
CREATE TABLE `standup_marks` (
	`account_id` integer NOT NULL,
	`meeting_id` integer NOT NULL,
	`todo_id` integer NOT NULL,
	`occurs_on` text NOT NULL,
	`kind` text NOT NULL,
	`covered_until` text NOT NULL,
	`marked_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `meeting_id`, `todo_id`, `occurs_on`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`meeting_id`) REFERENCES `meetings`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`todo_id`) REFERENCES `todos`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "standup_marks_kind_check" CHECK("standup_marks"."kind" IN ('said','dismissed'))
);
--> statement-breakpoint
CREATE INDEX `standup_marks_on_idx` ON `standup_marks` (`account_id`,`meeting_id`,`occurs_on`);--> statement-breakpoint
CREATE INDEX `standup_marks_todo_idx` ON `standup_marks` (`account_id`,`todo_id`);--> statement-breakpoint
DROP INDEX `events_todo_idx`;--> statement-breakpoint
CREATE INDEX `events_todo_time_idx` ON `events` (`account_id`,`todo_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `todos_activity_idx` ON `todos` (`account_id`,`last_activity_at`);