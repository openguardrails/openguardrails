/**
 * Simple JSONL file store for analysis logging
 * (No dependencies - just append-only log files)
 */

import type { AnalysisVerdict, AnalysisLogEntry, Logger } from "../agent/types.js";
import fs from "node:fs";
import path from "node:path";

// =============================================================================
// Row Types
// =============================================================================

type AnalysisRow = {
  id: number;
  timestamp: string;
  targetType: string;
  contentLength: number;
  chunksAnalyzed: number;
  verdict: AnalysisVerdict;
  durationMs: number;
  blocked: boolean;
};

type FeedbackRow = {
  id: number;
  timestamp: string;
  analysisId: number | null;
  feedbackType: string;
  reason: string | null;
};

// =============================================================================
// Helpers
// =============================================================================

function readLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  const results: T[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // skip malformed lines
    }
  }
  return results;
}

function getMaxId<T extends { id: number }>(rows: T[]): number {
  let max = 0;
  for (const row of rows) {
    if (row.id > max) max = row.id;
  }
  return max;
}

// =============================================================================
// Store Class
// =============================================================================

export class AnalysisStore {
  private analysisFile: string;
  private feedbackFile: string;
  private nextAnalysisId: number;
  private nextFeedbackId: number;
  private log: Logger;

  constructor(logPath: string, log: Logger) {
    this.log = log;

    // Ensure directory exists
    if (!fs.existsSync(logPath)) {
      fs.mkdirSync(logPath, { recursive: true });
    }

    this.analysisFile = path.join(logPath, "moltguard-analyses.jsonl");
    this.feedbackFile = path.join(logPath, "moltguard-feedback.jsonl");

    // Read existing data to determine next IDs
    const analyses = readLines<AnalysisRow>(this.analysisFile);
    const feedback = readLines<FeedbackRow>(this.feedbackFile);
    this.nextAnalysisId = getMaxId(analyses) + 1;
    this.nextFeedbackId = getMaxId(feedback) + 1;

    this.log.info(`Analysis store initialized at ${logPath}`);
  }

  /**
   * Log an analysis result
   */
  logAnalysis(entry: {
    targetType: string;
    contentLength: number;
    chunksAnalyzed: number;
    verdict: AnalysisVerdict;
    durationMs: number;
    blocked: boolean;
  }): number {
    const id = this.nextAnalysisId++;
    const row: AnalysisRow = {
      id,
      timestamp: new Date().toISOString(),
      targetType: entry.targetType,
      contentLength: entry.contentLength,
      chunksAnalyzed: entry.chunksAnalyzed,
      verdict: entry.verdict,
      durationMs: entry.durationMs,
      blocked: entry.blocked,
    };
    fs.appendFileSync(this.analysisFile, JSON.stringify(row) + "\n", "utf-8");
    return id;
  }

  /**
   * Get recent analysis logs
   */
  getRecentLogs(limit: number = 20): AnalysisLogEntry[] {
    const rows = readLines<AnalysisRow>(this.analysisFile);
    rows.sort((a, b) => (b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0));
    return rows.slice(0, limit);
  }

  /**
   * Get count of blocked analyses in time window
   */
  getBlockedCount(windowHours: number = 24): number {
    const windowStart = new Date();
    windowStart.setHours(windowStart.getHours() - windowHours);
    const cutoff = windowStart.toISOString();

    const rows = readLines<AnalysisRow>(this.analysisFile);
    let count = 0;
    for (const row of rows) {
      if (row.blocked && row.timestamp >= cutoff) count++;
    }
    return count;
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalAnalyses: number;
    totalBlocked: number;
    blockedLast24h: number;
    avgDurationMs: number;
  } {
    const rows = readLines<AnalysisRow>(this.analysisFile);
    let totalBlocked = 0;
    let totalDuration = 0;
    for (const row of rows) {
      if (row.blocked) totalBlocked++;
      totalDuration += row.durationMs;
    }

    return {
      totalAnalyses: rows.length,
      totalBlocked,
      blockedLast24h: this.getBlockedCount(24),
      avgDurationMs: rows.length > 0 ? Math.round(totalDuration / rows.length) : 0,
    };
  }

  /**
   * Get recent detections (only those flagged as injection)
   */
  getRecentDetections(limit: number = 10): AnalysisLogEntry[] {
    const rows = readLines<AnalysisRow>(this.analysisFile);
    const detections = rows.filter((r) => r.verdict.isInjection);
    detections.sort((a, b) => (b.timestamp > a.timestamp ? 1 : b.timestamp < a.timestamp ? -1 : 0));
    return detections.slice(0, limit);
  }

  /**
   * Log user feedback (false positive or missed detection)
   */
  logFeedback(entry: {
    analysisId?: number;
    feedbackType: "false_positive" | "missed_detection";
    reason?: string;
  }): number {
    const id = this.nextFeedbackId++;
    const row: FeedbackRow = {
      id,
      timestamp: new Date().toISOString(),
      analysisId: entry.analysisId ?? null,
      feedbackType: entry.feedbackType,
      reason: entry.reason ?? null,
    };
    fs.appendFileSync(this.feedbackFile, JSON.stringify(row) + "\n", "utf-8");
    return id;
  }

  /**
   * Get feedback statistics
   */
  getFeedbackStats(): {
    falsePositives: number;
    missedDetections: number;
  } {
    const rows = readLines<FeedbackRow>(this.feedbackFile);
    let falsePositives = 0;
    let missedDetections = 0;
    for (const row of rows) {
      if (row.feedbackType === "false_positive") falsePositives++;
      if (row.feedbackType === "missed_detection") missedDetections++;
    }
    return { falsePositives, missedDetections };
  }

  close(): void {
    // No-op for JSONL store (no connection to close)
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createAnalysisStore(logPath: string, log: Logger): AnalysisStore {
  return new AnalysisStore(logPath, log);
}
