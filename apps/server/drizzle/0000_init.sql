CREATE TABLE `api_tokens` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`token_hash` text NOT NULL,
	`scope` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`expires_at` text,
	`revoked_at` text,
	CONSTRAINT "api_tokens_scope_check" CHECK("api_tokens"."scope" IN ('read','write'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY NOT NULL,
	`todo_id` integer,
	`actor` text NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_todo_idx` ON `events` (`todo_id`);--> statement-breakpoint
CREATE TABLE `labels` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL COLLATE NOCASE,
	`scope` text,
	`value` text NOT NULL,
	`color` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`rank` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labels_name_unique` ON `labels` (`name`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` integer PRIMARY KEY NOT NULL,
	`first_name` text NOT NULL,
	`last_name` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `people_name_idx` ON `people` (lower("last_name"),lower("first_name"));--> statement-breakpoint
CREATE TABLE `projects` (
	`id` integer PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`color` text DEFAULT '#8B95A5' NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_slug_unique` ON `projects` (`slug`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `todo_labels` (
	`todo_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	PRIMARY KEY(`todo_id`, `label_id`),
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `labels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `todo_labels_label_idx` ON `todo_labels` (`label_id`);--> statement-breakpoint
CREATE TABLE `todo_people` (
	`todo_id` integer NOT NULL,
	`person_id` integer NOT NULL,
	`role` text DEFAULT 'requester' NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`todo_id`, `person_id`, `role`),
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "todo_people_role_check" CHECK("todo_people"."role" IN ('requester'))
);
--> statement-breakpoint
CREATE INDEX `todo_people_person_idx` ON `todo_people` (`person_id`);--> statement-breakpoint
CREATE TABLE `todos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer,
	`parent_id` integer,
	`title` text NOT NULL,
	`description_md` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`due_on` text,
	`planned_on` text,
	`position` real DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`done_at` text,
	`last_activity_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "todos_status_check" CHECK("todos"."status" IN ('open','in_progress','blocked','done')),
	CONSTRAINT "todos_title_check" CHECK(length("todos"."title") BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE INDEX `todos_project_idx` ON `todos` (`project_id`);--> statement-breakpoint
CREATE INDEX `todos_status_idx` ON `todos` (`status`);