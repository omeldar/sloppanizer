-- Hand edits: drizzle-kit wanted to rebuild the table (and copied columns that do not exist yet). The
-- columns are added in place; author_kind needs a DEFAULT for that (inserts always set it).
ALTER TABLE `comments` ADD `author_kind` text DEFAULT 'token' NOT NULL CONSTRAINT "comments_author_kind_check" CHECK("author_kind" IN ('session','token'));--> statement-breakpoint
ALTER TABLE `comments` ADD `author_token_id` integer REFERENCES `api_tokens`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
-- Existing comments only have the author's name: "you" is the session; a token comment belongs to the
-- token that had that name and was active when the comment was written (the newest one if several).
-- services/comments.ts linkCommentAuthors does the same after a restore.
UPDATE `comments` SET `author_kind` = 'session' WHERE `actor` = 'you';--> statement-breakpoint
UPDATE `comments` SET `author_token_id` = (
	SELECT t.`id` FROM `api_tokens` t
	WHERE t.`name` = `comments`.`actor` AND t.`created_at` <= `comments`.`created_at`
		AND (t.`revoked_at` IS NULL OR t.`revoked_at` >= `comments`.`created_at`)
	ORDER BY t.`created_at` DESC, t.`id` DESC LIMIT 1
) WHERE `author_kind` = 'token';
