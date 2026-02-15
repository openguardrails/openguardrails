/**
 * Gateway process manager for the MoltGuard plugin
 *
 * Manages the lifecycle of the local sanitization gateway process.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "./agent/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type GatewayOptions = {
  port: number;
  autoStart: boolean;
};

export class GatewayManager {
  private process: ChildProcess | null = null;
  private port: number;
  private autoStart: boolean;
  private log: Logger;
  private isReady = false;

  constructor(options: GatewayOptions, logger: Logger) {
    this.port = options.port;
    this.autoStart = options.autoStart;
    this.log = logger;
  }

  /**
   * Start the gateway process
   */
  async start(): Promise<void> {
    if (this.process) {
      this.log.warn("Gateway already running");
      return;
    }

    if (!this.autoStart) {
      this.log.info("Gateway autoStart disabled, skipping");
      return;
    }

    try {
      this.log.info(`Starting gateway on port ${this.port}...`);

      // Spawn gateway process
      // Use compiled JS if available, fallback to TS
      const gatewayJsPath = join(__dirname, "dist", "gateway", "index.js");
      const gatewayTsPath = join(__dirname, "gateway", "index.ts");

      const fs = await import("node:fs");
      const gatewayPath = fs.existsSync(gatewayJsPath) ? gatewayJsPath : gatewayTsPath;

      // Try bun first (fast TypeScript support), fallback to node
      const runtime = process.execPath.includes("bun") ? "bun" : "node";
      const args = runtime === "bun"
        ? [gatewayPath]
        : gatewayPath.endsWith(".js")
          ? [gatewayPath]
          : ["--experimental-strip-types", "--no-warnings", gatewayPath];

      this.process = spawn(
        runtime,
        args,
        {
          env: {
            ...process.env,
            MOLTGUARD_GATEWAY_PORT: String(this.port),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      // Handle stdout
      this.process.stdout?.on("data", (data) => {
        const output = data.toString().trim();
        if (output) {
          this.log.info(`[gateway] ${output}`);

          // Check if gateway is ready
          if (output.includes("Ready to proxy requests")) {
            this.isReady = true;
          }
        }
      });

      // Handle stderr
      this.process.stderr?.on("data", (data) => {
        const output = data.toString().trim();
        if (output) {
          this.log.error(`[gateway] ${output}`);
        }
      });

      // Handle process exit
      this.process.on("exit", (code, signal) => {
        this.log.warn(`Gateway process exited (code: ${code}, signal: ${signal})`);
        this.process = null;
        this.isReady = false;
      });

      // Handle process errors
      this.process.on("error", (error) => {
        this.log.error(`Gateway process error: ${error.message}`);
        this.process = null;
        this.isReady = false;
      });

      // Wait for gateway to be ready (with timeout)
      const ready = await this.waitForReady(10000);
      if (ready) {
        this.log.info(`Gateway started successfully on http://127.0.0.1:${this.port}`);
      } else {
        this.log.warn("Gateway started but ready signal not received within timeout");
      }
    } catch (error) {
      this.log.error(`Failed to start gateway: ${error}`);
      throw error;
    }
  }

  /**
   * Stop the gateway process
   */
  async stop(): Promise<void> {
    if (!this.process) {
      this.log.info("Gateway not running");
      return;
    }

    this.log.info("Stopping gateway...");

    return new Promise((resolve) => {
      if (!this.process) {
        resolve();
        return;
      }

      this.process.once("exit", () => {
        this.log.info("Gateway stopped");
        this.process = null;
        this.isReady = false;
        resolve();
      });

      // Send SIGTERM
      this.process.kill("SIGTERM");

      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.process) {
          this.log.warn("Gateway did not stop gracefully, forcing kill");
          this.process.kill("SIGKILL");
        }
      }, 5000);
    });
  }

  /**
   * Restart the gateway process
   */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Check if gateway is running
   */
  isRunning(): boolean {
    return this.process !== null && this.isReady;
  }

  /**
   * Get gateway status
   */
  getStatus(): { running: boolean; port: number; ready: boolean } {
    return {
      running: this.process !== null,
      port: this.port,
      ready: this.isReady,
    };
  }

  /**
   * Wait for gateway to be ready
   */
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
