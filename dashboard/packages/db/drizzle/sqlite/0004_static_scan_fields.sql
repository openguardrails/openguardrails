-- Add static scan fields to detection_results table
ALTER TABLE `detection_results` ADD `scan_type` text DEFAULT 'dynamic' NOT NULL;
--> statement-breakpoint
ALTER TABLE `detection_results` ADD `file_path` text;
--> statement-breakpoint
ALTER TABLE `detection_results` ADD `file_type` text;
--> statement-breakpoint
CREATE INDEX `idx_detection_results_scan_type` ON `detection_results` (`scan_type`);
