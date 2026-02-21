/**
 * Dashboard process manager for the OpenGuardrails plugin
 *
 * Manages the lifecycle of the embedded OpenGuardrails Dashboard API process.
 * The dashboard API serves both the REST API and static Next.js frontend.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync } from "node:fs";
import type { Logger } from "./agent/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type DashboardOptions = {
  port: number;
  /** Path to the @openguardrails/api entry point (auto-detected if not set) */
  apiEntryPoint?: string;
};

export class DashboardManager {
  private process: ChildProcess | null = null;
  private port: number;
  private apiEntryPoint: string;
  private log: Logger;
  private isReady = false;
  private sessionToken: string | null = null;
  private stateFilePath: string;
  private logFilePath: string;
  private adopted = false;

  constructor(options: DashboardOptions, logger: Logger) {
    this.port = options.port;
    this.log = logger;
    const stateDir = join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".openclaw", "extensions", "openguardrails",
    );
    this.stateFilePath = join(stateDir, "dashboard.state.json");
    this.logFilePath = join(stateDir, "dashboard.log");

    // Try to find the API entry point
    if (options.apiEntryPoint) {
      this.apiEntryPoint = options.apiEntryPoint;
    } else {
      // Look for @openguardrails/api in node_modules or sibling packages
      const repoRoot = join(__dirname, "..");
      const possiblePaths = [
        // When installed as dependency
        join(__dirname, "node_modules", "@openguardrails", "api", "dist", "index.js"),
        join(__dirname, "node_modules", "@ogp", "platform-api", "dist", "index.js"),
        // In monorepo workspace (plugin is at openclaw-security/, repo root is ..)
        join(repoRoot, "dashboard", "apps", "api", "dist", "index.js"),
        join(repoRoot, "dashboard", "apps", "platform-api", "dist", "index.js"),
        // Dev mode (TypeScript)
        join(repoRoot, "dashboard", "apps", "api", "src", "index.ts"),
        join(repoRoot, "dashboard", "apps", "platform-api", "src", "index.ts"),
      ];

      // Default to the first path; actual existence check happens at start()
      this.apiEntryPoint = possiblePaths[0]!;
      const fs = require("node:fs") as typeof import("node:fs");
      for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
          this.apiEntryPoint = p;
          break;
        }
      }
    }
  }

  async start(): Promise<void> {
    if (this.process || this.adopted) {
      this.log.warn("Dashboard already running");
      return;
    }

    // Check if an existing dashboard is already serving on the port
    if (await this.healthCheck()) {
      this.log.info(`Dashboard already running on port ${this.port} (adopted existing process)`);
      this.adopted = true;
      this.isReady = true;
      this.loadState();
      return;
    }

    try {
      this.log.info(`Starting embedded dashboard on port ${this.port}...`);

      let runtime: string;
      let args: string[];

      if (process.execPath.includes("bun")) {
        runtime = process.execPath;
        args = [this.apiEntryPoint];
      } else if (this.apiEntryPoint.endsWith(".js")) {
        runtime = process.execPath;
        args = [this.apiEntryPoint];
      } else {
        // .ts files need tsx to handle ESM import rewriting (.js → .ts)
        const tsxBin = join(dirname(dirname(this.apiEntryPoint)), "node_modules", ".bin", "tsx");
        runtime = tsxBin;
        args = [this.apiEntryPoint];
      }

      // Write stdout/stderr to a log file instead of pipes.
      // Pipes break when the parent exits, causing EPIPE crashes in the child.
      const logDir = dirname(this.logFilePath);
      mkdirSync(logDir, { recursive: true });
      const logFd = openSync(this.logFilePath, "w");

      this.process = spawn(
        runtime,
        args,
        {
          cwd: dirname(dirname(this.apiEntryPoint)),
          env: {
            ...process.env,
            PORT: String(this.port),
            DASHBOARD_MODE: "embedded",
            // SQLite DB in ~/.openclaw/extensions/openguardrails/
            DATABASE_URL: "",
            DB_DIALECT: "sqlite",
            SQLITE_PATH: join(
              process.env.HOME || process.env.USERPROFILE || ".",
              ".openclaw", "extensions", "openguardrails", "openguardrails.db"
            ),
          },
          stdio: ["ignore", logFd, logFd],
          detached: true,
        },
      );

      // Close the fd from parent side — child keeps its own copy
      closeSync(logFd);

      this.process.on("exit", (code, signal) => {
        this.log.warn(`Dashboard process exited (code: ${code}, signal: ${signal})`);
        this.process = null;
        this.isReady = false;
      });

      this.process.on("error", (error) => {
        this.log.error(`Dashboard process error: ${error.message}`);
        this.process = null;
        this.isReady = false;
      });

      // Allow parent to exit without waiting for this child
      this.process.unref();

      // Poll health endpoint for readiness instead of parsing stdout
      const ready = await this.waitForHealthy(15000);
      if (ready) {
        // Capture session token from log file
        this.captureSessionToken();
        this.saveState();
      } else {
        this.log.warn("Dashboard started but health check not passing within timeout");
      }
    } catch (error) {
      this.log.error(`Failed to start dashboard: ${error}`);
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.log.info("Stopping dashboard...");

    if (this.process) {
      await new Promise<void>((resolve) => {
        this.process!.once("exit", () => {
          this.log.info("Dashboard stopped");
          this.process = null;
          resolve();
        });
        this.process!.kill("SIGTERM");
        setTimeout(() => {
          if (this.process) {
            this.log.warn("Dashboard did not stop gracefully, forcing kill");
            this.process.kill("SIGKILL");
          }
        }, 5000);
      });
    } else {
      // Kill by PID from state file (adopted or orphaned process)
      const state = this.readState();
      // Validate PID is a positive integer in a reasonable OS range before using it
      const pid = state?.pid;
      if (pid && Number.isInteger(pid) && pid > 1 && pid <= 4194304 && this.isProcessAlive(pid)) {
        try {
          process.kill(pid, "SIGTERM");
          await new Promise((r) => setTimeout(r, 2000));
          if (this.isProcessAlive(pid)) {
            process.kill(pid, "SIGKILL");
          }
          this.log.info("Dashboard stopped (by PID)");
        } catch {
          this.log.warn("Failed to kill dashboard process by PID");
        }
      }
    }

    this.isReady = false;
    this.adopted = false;
    this.removeState();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  isRunning(): boolean {
    return (this.process !== null || this.adopted) && this.isReady;
  }

  getStatus(): { running: boolean; port: number; ready: boolean; sessionToken: string | null } {
    return {
      running: this.process !== null || this.adopted,
      port: this.port,
      ready: this.isReady,
      sessionToken: this.sessionToken,
    };
  }

  private async waitForHealthy(timeoutMs: number): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      if (await this.healthCheck()) {
        this.isReady = true;
        return true;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  private captureSessionToken(): void {
    try {
      if (!existsSync(this.logFilePath)) return;
      const logContent = readFileSync(this.logFilePath, "utf-8");
      const tokenMatch = logContent.match(/Session token: (og-session-\w+)/);
      if (tokenMatch) {
        this.sessionToken = tokenMatch[1]!;
        this.log.info(`[dashboard] Session token captured`);
      }
    } catch {}
  }

  private async healthCheck(): Promise<boolean> {
    try {
      const http = await import("node:http");
      return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${this.port}/health`, { timeout: 2000 }, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
      });
    } catch {
      return false;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private saveState(): void {
    try {
      const dir = dirname(this.stateFilePath);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(this.stateFilePath, JSON.stringify({
        pid: this.process?.pid,
        port: this.port,
        sessionToken: this.sessionToken,
      }), { mode: 0o600 });
    } catch {}
  }

  private readState(): { pid?: number; port?: number; sessionToken?: string } | null {
    try {
      if (!existsSync(this.stateFilePath)) return null;
      return JSON.parse(readFileSync(this.stateFilePath, "utf-8"));
    } catch {
      return null;
    }
  }

  private loadState(): void {
    const state = this.readState();
    if (state?.sessionToken) {
      this.sessionToken = state.sessionToken;
    }
  }

  private removeState(): void {
    try {
      if (existsSync(this.stateFilePath)) unlinkSync(this.stateFilePath);
    } catch {}
  }
}
