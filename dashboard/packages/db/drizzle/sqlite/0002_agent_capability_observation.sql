CREATE TABLE `tool_call_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`agent_id` text NOT NULL,
	`session_key` text,
	`tool_name` text NOT NULL,
	`category` text,
	`access_pattern` text,
	`params_json` text,
	`phase` text NOT NULL,
	`result_json` text,
	`error` text,
	`duration_ms` integer,
	`blocked` integer DEFAULT false NOT NULL,
	`block_reason` text,
	`timestamp` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_tool_obs_agent_id` ON `tool_call_observations` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_tool_obs_tool_name` ON `tool_call_observations` (`tool_name`);--> statement-breakpoint
CREATE INDEX `idx_tool_obs_timestamp` ON `tool_call_observations` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_tool_obs_tenant_id` ON `tool_call_observations` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `agent_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`agent_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`category` text,
	`access_pattern` text,
	`targets_json` text DEFAULT '[]' NOT NULL,
	`call_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL
);--> statement-breakpoint
CREATE INDEX `idx_agent_perms_agent_id` ON `agent_permissions` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_perms_tool_name` ON `agent_permissions` (`tool_name`);--> statement-breakpoint
CREATE INDEX `idx_agent_perms_tenant_id` ON `agent_permissions` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_perms_unique` ON `agent_permissions` (`tenant_id`, `agent_id`, `tool_name`);
