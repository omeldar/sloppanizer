-- Hand-written: drizzle-kit rebuilds accounts for a new CHECK, and dropping accounts would cascade into
-- every account's data. ADD COLUMN keeps the rows.
ALTER TABLE `accounts` ADD `date_format` text DEFAULT 'dmy.' NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `time_format` text DEFAULT '24h' NOT NULL;
