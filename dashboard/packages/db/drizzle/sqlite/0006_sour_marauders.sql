CREATE TABLE IF NOT EXISTS `agentic_hours_local` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text DEFAULT 'default' NOT NULL,
	`agent_id` text NOT NULL,
	`date` text NOT NULL,
	`tool_call_duration_ms` integer DEFAULT 0 NOT NULL,
	`llm_duration_ms` integer DEFAULT 0 NOT NULL,
	`total_duration_ms` integer DEFAULT 0 NOT NULL,
	`tool_call_count` integer DEFAULT 0 NOT NULL,
	`llm_call_count` integer DEFAULT 0 NOT NULL,
	`session_count` integer DEFAULT 0 NOT NULL,
	`block_count` integer DEFAULT 0 NOT NULL,
	`risk_event_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agentic_hours_agent_date` ON `agentic_hours_local` (`tenant_id`,`agent_id`,`date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agentic_hours_tenant_date` ON `agentic_hours_local` (`tenant_id`,`date`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `tool_call_observations` (
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
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tool_obs_agent_id` ON `tool_call_observations` (`agent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tool_obs_tool_name` ON `tool_call_observations` (`tool_name`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tool_obs_timestamp` ON `tool_call_observations` (`timestamp`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tool_obs_tenant_id` ON `tool_call_observations` (`tenant_id`);
