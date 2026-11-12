-- Hand edits: name_key is nullable here (the schema says notNull so inserts must set it). SQLite cannot
-- lowercase non-ASCII letters, so the server fills the column in JS (services/name-keys.ts, at every
-- start), merging names that differ only in case. NULLs do not clash in a unique index.
ALTER TABLE `labels` ADD `name_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `labels_name_key_unique` ON `labels` (`name_key`);--> statement-breakpoint
ALTER TABLE `person_tags` ADD `name_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `person_tags_name_key_unique` ON `person_tags` (`name_key`);--> statement-breakpoint
ALTER TABLE `topics` ADD `name_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `topics_name_key_unique` ON `topics` (`name_key`);
