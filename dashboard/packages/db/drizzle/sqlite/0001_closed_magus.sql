ALTER TABLE `agents` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_agents_tenant_id` ON `agents` (`tenant_id`);--> statement-breakpoint
ALTER TABLE `detection_results` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_detection_results_tenant_id` ON `detection_results` (`tenant_id`);--> statement-breakpoint
ALTER TABLE `policies` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_policies_tenant_id` ON `policies` (`tenant_id`);--> statement-breakpoint
ALTER TABLE `scanner_definitions` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_scanner_defs_tenant_id` ON `scanner_definitions` (`tenant_id`);--> statement-breakpoint
ALTER TABLE `usage_logs` ADD `tenant_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_usage_logs_tenant_id` ON `usage_logs` (`tenant_id`);