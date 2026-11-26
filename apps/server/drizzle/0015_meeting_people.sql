CREATE TABLE `meeting_people` (
	`account_id` integer NOT NULL,
	`meeting_id` integer NOT NULL,
	`person_id` integer NOT NULL,
	`added_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `meeting_id`, `person_id`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`meeting_id`) REFERENCES `meetings`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`account_id`,`person_id`) REFERENCES `people`(`account_id`,`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `meeting_people_person_idx` ON `meeting_people` (`account_id`,`person_id`);