CREATE TABLE `profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`memory` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `turns` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`user_text` text NOT NULL,
	`assistant_text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'generating' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_turns_user_created` ON `turns` (`user_id`,`created_at`);