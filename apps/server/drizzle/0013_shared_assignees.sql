-- Hand-written: drizzle-kit leaves ON DELETE off a column added with ADD COLUMN, and a table rebuild
-- would cascade (see docs/DECISIONS.md, 0008). SQLite allows ADD COLUMN with a foreign key whose
-- default is NULL, so todos keeps every row.
ALTER TABLE `todos` ADD `assignee_id` integer REFERENCES accounts(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `todos_assignee_idx` ON `todos` (`assignee_id`,`account_id`);
