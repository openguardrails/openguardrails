CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`provider` text DEFAULT 'custom' NOT NULL,
	`status` text DEFAULT 'inactive' NOT NULL,
	`last_seen_at` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agents_status` ON `agents` (`status`);--> statement-breakpoint
CREATE TABLE `detection_results` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`safe` integer NOT NULL,
	`categories` text DEFAULT '[]' NOT NULL,
	`sensitivity_score` real DEFAULT 0 NOT NULL,
	`findings` text DEFAULT '[]' NOT NULL,
	`latency_ms` integer NOT NULL,
	`request_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_detection_results_agent_id` ON `detection_results` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_detection_results_created_at` ON `detection_results` (`created_at`);--> statement-breakpoint
CREATE TABLE `policies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`scanner_ids` text DEFAULT '[]' NOT NULL,
	`action` text DEFAULT 'log' NOT NULL,
	`sensitivity_threshold` real DEFAULT 0.5 NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scanner_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`scanner_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`is_enabled` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_scanner_defs_scanner_id` ON `scanner_definitions` (`scanner_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text,
	`endpoint` text NOT NULL,
	`status_code` integer NOT NULL,
	`response_safe` integer,
	`categories` text DEFAULT '[]' NOT NULL,
	`latency_ms` integer NOT NULL,
	`request_id` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_usage_logs_agent_id` ON `usage_logs` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_usage_logs_created_at` ON `usage_logs` (`created_at`);