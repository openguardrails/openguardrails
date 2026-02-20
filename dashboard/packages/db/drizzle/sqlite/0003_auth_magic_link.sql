CREATE TABLE `magic_links` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `magic_links_token_unique` ON `magic_links` (`token`);
--> statement-breakpoint
CREATE INDEX `idx_magic_links_token` ON `magic_links` (`token`);
--> statement-breakpoint
CREATE INDEX `idx_magic_links_email` ON `magic_links` (`email`);
--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_sessions_token_unique` ON `user_sessions` (`token`);
--> statement-breakpoint
CREATE INDEX `idx_user_sessions_token` ON `user_sessions` (`token`);
--> statement-breakpoint
CREATE INDEX `idx_user_sessions_email` ON `user_sessions` (`email`);
