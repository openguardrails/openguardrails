/**
 * File System Watcher for Auto-Scanning
 *
 * Monitors workspace .md files for changes and triggers automatic security scans.
 * Debounces rapid changes to avoid excessive scanning.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Logger } from "./types.js";

export interface FileWatcherConfig {
  /** Workspace directory to watch */
  workspaceDir?: string;
  /** Debounce delay in ms (default: 3000) */
  debounceMs?: number;
  /** Callback when file changes detected */
  onFilesChanged: (files: string[]) => Promise<void>;
  /** Logger */
  logger?: Logger;
}

export class FileWatcher {
  private watchers: fs.FSWatcher[] = [];
  private pendingFiles = new Set<string>();
  private debounceTimer: NodeJS.Timeout | null = null;
  private config: Required<Omit<FileWatcherConfig, "logger">> & { logger?: Logger };
  private isRunning = false;

  constructor(config: FileWatcherConfig) {
    this.config = {
      workspaceDir: config.workspaceDir || path.join(os.homedir(), ".openclaw"),
      debounceMs: config.debounceMs ?? 3000,
      onFilesChanged: config.onFilesChanged,
      logger: config.logger,
    };
  }

  /**
   * Start watching workspace directories
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const watchPaths = [
      this.config.workspaceDir, // Root (soul.md, agent.md, heartbeat.md)
      path.join(this.config.workspaceDir, "memories"),
      path.join(this.config.workspaceDir, "skills"),
      path.join(this.config.workspaceDir, "plugins"),
    ];

    for (const watchPath of watchPaths) {
      try {
        if (!fs.existsSync(watchPath)) continue;

        const watcher = fs.watch(
          watchPath,
          { recursive: true },
          (eventType, filename) => {
            if (!filename) return;

            // Only watch .md files
            if (!filename.endsWith(".md")) return;

            // Ignore node_modules and hidden directories
            if (filename.includes("node_modules") || filename.includes("/.")) return;

            const fullPath = path.join(watchPath, filename);
            this.scheduleScann(fullPath);
          }
        );

        watcher.unref();
        this.watchers.push(watcher);
        this.config.logger?.debug?.(`Watching: ${watchPath}`);
      } catch (err) {
        this.config.logger?.debug?.(`Failed to watch ${watchPath}: ${err}`);
      }
    }

    if (this.watchers.length > 0) {
      this.config.logger?.info(`File watcher started (${this.watchers.length} directories)`);
    }
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (!this.isRunning) return;

    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.pendingFiles.clear();
    this.isRunning = false;
    this.config.logger?.info("File watcher stopped");
  }

  /**
   * Schedule a file for scanning (debounced)
   */
  private scheduleScann(filePath: string): void {
    this.pendingFiles.add(filePath);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.processPendingScans();
    }, this.config.debounceMs);
    this.debounceTimer.unref();
  }

  /**
   * Process all pending scans
   */
  private async processPendingScans(): Promise<void> {
    if (this.pendingFiles.size === 0) return;

    const files = Array.from(this.pendingFiles);
    this.pendingFiles.clear();
    this.debounceTimer = null;

    // Filter to only existing files
    const existingFiles = files.filter(f => {
      try {
        return fs.existsSync(f) && fs.statSync(f).isFile();
      } catch {
        return false;
      }
    });

    if (existingFiles.length === 0) return;

    this.config.logger?.debug?.(
      `Auto-scanning ${existingFiles.length} changed file(s)...`
    );

    try {
      await this.config.onFilesChanged(existingFiles);
    } catch (err) {
      this.config.logger?.debug?.(`Auto-scan failed: ${err}`);
    }
  }

  /**
   * Check if watcher is running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get number of watched directories
   */
  get watchCount(): number {
    return this.watchers.length;
  }
}
