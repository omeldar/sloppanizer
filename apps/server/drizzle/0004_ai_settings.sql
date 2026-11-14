CREATE TABLE `ai_settings` (
	`account_id` integer PRIMARY KEY NOT NULL,
	`provider` text DEFAULT 'none' NOT NULL,
	`claude_model` text DEFAULT 'claude-opus-5-5' NOT NULL,
	`claude_key_enc` text,
	`ollama_url` text DEFAULT 'http://localhost:11434' NOT NULL,
	`ollama_model` text DEFAULT 'jaahas/qwen3.5-uncensored:9b' NOT NULL,
	`day_start` text DEFAULT '09:00' NOT NULL,
	`day_end` text DEFAULT '18:00' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
