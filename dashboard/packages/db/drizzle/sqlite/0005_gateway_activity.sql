-- Gateway Activity Table
-- Records of gateway sanitization and restoration events

CREATE TABLE IF NOT EXISTS `gateway_activity` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL DEFAULT 'default',
  `event_id` text NOT NULL,
  `request_id` text NOT NULL,
  `timestamp` text NOT NULL,
  `type` text NOT NULL,
  `direction` text NOT NULL,
  `backend` text NOT NULL,
  `endpoint` text NOT NULL,
  `model` text,
  `redaction_count` integer NOT NULL DEFAULT 0,
  `categories` text DEFAULT '{}' NOT NULL,
  `duration_ms` integer,
  `created_at` text NOT NULL
);

CREATE INDEX IF NOT EXISTS `idx_gateway_activity_request_id` ON `gateway_activity` (`request_id`);
CREATE INDEX IF NOT EXISTS `idx_gateway_activity_timestamp` ON `gateway_activity` (`timestamp`);
CREATE INDEX IF NOT EXISTS `idx_gateway_activity_type` ON `gateway_activity` (`type`);
CREATE INDEX IF NOT EXISTS `idx_gateway_activity_tenant_id` ON `gateway_activity` (`tenant_id`);
