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

  constructor(options: DashboardOptions, logger: Logger) {
    this.port = options.port;
    this.log = logger;

    // Try to find the API entry point
    if (options.apiEntryPoint) {
      this.apiEntryPoint = options.apiEntryPoint;
    } else {
      // Look for @openguardrails/api in node_modules or sibling packages
      const possiblePaths = [
        // When installed as dependency
        join(__dirname, "node_modules", "@openguardrails", "api", "dist", "index.js"),
        join(__dirname, "node_modules", "@ogp", "platform-api", "dist", "index.js"),
        // In monorepo workspace
        join(__dirname, "..", "apps", "api", "dist", "index.js"),
        join(__dirname, "..", "dashboard", "apps", "platform-api", "dist", "index.js"),
        // Dev mode (TypeScript)
        join(__dirname, "..", "apps", "api", "src", "index.ts"),
        join(__dirname, "..", "dashboard", "apps", "platform-api", "src", "index.ts"),
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
    if (this.process) {
      this.log.warn("Dashboard already running");
      return;
    }

    try {
      this.log.info(`Starting embedded dashboard on port ${this.port}...`);

      const runtime = process.execPath.includes("bun") ? "bun" : "node";
      const args = runtime === "bun"
        ? [this.apiEntryPoint]
        : this.apiEntryPoint.endsWith(".js")
          ? [this.apiEntryPoint]
          : ["--experimental-strip-types", "--no-warnings", this.apiEntryPoint];

      this.process = spawn(
        runtime,
        args,
        {
          env: {
            ...process.env,
            PORT: String(this.port),
            DASHBOARD_MODE: "embedded",
            // SQLite DB in ~/.openclaw/data/
            DATABASE_URL: "",
            DB_DIALECT: "sqlite",
            SQLITE_PATH: join(
              process.env.HOME || process.env.USERPROFILE || ".",
              ".openclaw", "data", "openguardrails.db"
            ),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      this.process.stdout?.on("data", (data) => {
        const output = data.toString().trim();
        if (output) {
          this.log.info(`[dashboard] ${output}`);

          // Capture session token from startup output
          const tokenMatch = output.match(/Session token: (og-session-\w+)/);
          if (tokenMatch) {
            this.sessionToken = tokenMatch[1]!;
          }

          if (output.includes("running on port") || output.includes("OpenGuardrails API")) {
            this.isReady = true;
          }
        }
      });

      this.process.stderr?.on("data", (data) => {
        const output = data.toString().trim();
        if (output) {
          this.log.error(`[dashboard] ${output}`);
        }
      });

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

      const ready = await this.waitForReady(15000);
      if (ready) {
        this.log.info(`Dashboard started on http://localhost:${this.port}`);
        if (this.sessionToken) {
          this.log.info(`Dashboard session token: ${this.sessionToken}`);
        }
      } else {
        this.log.warn("Dashboard started but ready signal not received within timeout");
      }
    } catch (error) {
      this.log.error(`Failed to start dashboard: ${error}`);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.process) {
      return;
    }

    this.log.info("Stopping dashboard...");

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      this.process.once("exit", () => {
        this.log.info("Dashboard stopped");
        this.process = null;
        this.isReady = false;
        resolve();
      });

      this.process.kill("SIGTERM");

      setTimeout(() => {
        if (this.process) {
          this.log.warn("Dashboard did not stop gracefully, forcing kill");
          this.process.kill("SIGKILL");
        }
      }, 5000);
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  getSessionToken(): string | null {
    return this.sessionToken;
  }

  isRunning(): boolean {
    return this.process !== null && this.isReady;
  }

  getStatus(): { running: boolean; port: number; ready: boolean; sessionToken: string | null } {
    return {
      running: this.process !== null,
      port: this.port,
      ready: this.isReady,
      sessionToken: this.sessionToken,
    };
  }

  private waitForReady(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const checkInterval = setInterval(() => {
        if (this.isReady) {
          clearInterval(checkInterval);
          resolve(true);
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(checkInterval);
          resolve(false);
        }
      }, 100);
    });
  }
}
