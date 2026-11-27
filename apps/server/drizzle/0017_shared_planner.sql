-- Hand-written like 0013: drizzle-kit leaves ON DELETE off a column added with ADD COLUMN, and a table
-- rebuild would cascade. SQLite allows ADD COLUMN with a foreign key whose default is NULL.
ALTER TABLE `time_blocks` ADD `member_id` integer REFERENCES accounts(id) ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX `time_blocks_member_idx` ON `time_blocks` (`member_id`,`account_id`,`start_at`);
