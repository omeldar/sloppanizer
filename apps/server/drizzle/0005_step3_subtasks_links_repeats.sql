CREATE TABLE `todo_links` (
	`id` integer PRIMARY KEY NOT NULL,
	`from_id` integer NOT NULL,
	`to_id` integer NOT NULL,
	`kind` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`from_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "todo_links_kind_check" CHECK("todo_links"."kind" IN ('blocks','relates')),
	CONSTRAINT "todo_links_self_check" CHECK("todo_links"."from_id" <> "todo_links"."to_id")
);
--> statement-breakpoint
CREATE INDEX `todo_links_to_idx` ON `todo_links` (`to_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `todo_links_pair_unique` ON `todo_links` (`from_id`,`to_id`,`kind`);--> statement-breakpoint
-- Hand edits: drizzle-kit leaves out the json CHECK and the ON DELETE of an added column, and qualifies
-- the partial index condition with the table name.
ALTER TABLE `todos` ADD `recurrence` text CONSTRAINT "todos_recurrence_check" CHECK("recurrence" IS NULL OR json_valid("recurrence"));--> statement-breakpoint
ALTER TABLE `todos` ADD `recurrence_prev_id` integer REFERENCES `todos`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
CREATE INDEX `todos_parent_idx` ON `todos` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `todos_recurrence_prev_idx` ON `todos` (`recurrence_prev_id`) WHERE "recurrence_prev_id" IS NOT NULL;