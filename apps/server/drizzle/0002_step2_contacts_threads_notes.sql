CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attachments_sha256_idx` ON `attachments` (`sha256`);--> statement-breakpoint
CREATE TABLE `comments` (
	`id` integer PRIMARY KEY NOT NULL,
	`todo_id` integer NOT NULL,
	`actor` text NOT NULL,
	`body_md` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`edited_at` text,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "comments_body_check" CHECK(length("comments"."body_md") BETWEEN 1 AND 50000)
);
--> statement-breakpoint
CREATE INDEX `comments_todo_idx` ON `comments` (`todo_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY NOT NULL,
	`project_id` integer,
	`title` text NOT NULL,
	`body_md` text DEFAULT '' NOT NULL,
	`pinned_at` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "notes_title_check" CHECK(length("notes"."title") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX `notes_project_idx` ON `notes` (`project_id`);--> statement-breakpoint
CREATE TABLE `person_tag_links` (
	`person_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`person_id`, `tag_id`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `person_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `person_tag_links_tag_idx` ON `person_tag_links` (`tag_id`);--> statement-breakpoint
CREATE TABLE `person_tags` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL COLLATE NOCASE,
	`color` text DEFAULT '#8B95A5' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_tags_name_unique` ON `person_tags` (`name`);--> statement-breakpoint
CREATE TABLE `person_topics` (
	`person_id` integer NOT NULL,
	`topic_id` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`person_id`, `topic_id`),
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`topic_id`) REFERENCES `topics`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `person_topics_topic_idx` ON `person_topics` (`topic_id`);--> statement-breakpoint
CREATE TABLE `topics` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL COLLATE NOCASE,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `topics_name_unique` ON `topics` (`name`);--> statement-breakpoint
-- todo_people gets the 'contact' role: SQLite cannot change a CHECK in place, so the table is rebuilt.
-- The migrator runs inside a transaction, where the foreign_keys pragmas below do nothing; that is fine
-- because no table references todo_people. The CHECK names the column without the table, so the rename
-- cannot leave a stale table name in it.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_todo_people` (
	`todo_id` integer NOT NULL,
	`person_id` integer NOT NULL,
	`role` text DEFAULT 'requester' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`todo_id`, `person_id`, `role`),
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "todo_people_role_check" CHECK("role" IN ('requester','contact'))
);
--> statement-breakpoint
INSERT INTO `__new_todo_people`("todo_id", "person_id", "role", "created_at") SELECT "todo_id", "person_id", "role", "created_at" FROM `todo_people`;--> statement-breakpoint
DROP TABLE `todo_people`;--> statement-breakpoint
ALTER TABLE `__new_todo_people` RENAME TO `todo_people`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `todo_people_person_idx` ON `todo_people` (`person_id`);--> statement-breakpoint
ALTER TABLE `people` ADD `team` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `email` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `people` ADD `notes_md` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `people_team_idx` ON `people` (lower("team"));