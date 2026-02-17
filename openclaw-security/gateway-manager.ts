/**
 * AI Security Gateway process manager for the OpenGuardrails plugin
 *
 * Manages the lifecycle of the AI Security Gateway process.
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
      this.log.info(`Starting AI Security Gateway on port ${this.port}...`);

      // Spawn gateway process
      // Look for standalone gateway package (monorepo), fallback to compiled dist
      const repoRoot = join(__dirname, "..");
      const gatewayTsPath = join(repoRoot, "gateway", "src", "index.ts");
      const gatewayJsPath = join(repoRoot, "gateway", "dist", "index.js");

      const fs = await import("node:fs");
      const useCompiledJs = fs.existsSync(gatewayJsPath);
      const gatewayPath = useCompiledJs ? gatewayJsPath : gatewayTsPath;

      // Determine runtime: bun handles TS natively, tsx for dev, node for compiled JS
      let runtime: string;
      let args: string[];

      if (process.execPath.includes("bun")) {
        runtime = process.execPath;
        args = [gatewayPath];
      } else if (useCompiledJs) {
        runtime = process.execPath;
        args = [gatewayPath];
      } else {
        // Dev mode: use tsx to handle TypeScript with .js import specifiers
        const tsxPaths = [
          join(repoRoot, "gateway", "node_modules", ".bin", "tsx"),
          join(repoRoot, "dashboard", "node_modules", ".bin", "tsx"),
          join(__dirname, "node_modules", ".bin", "tsx"),
        ];
        const fs2 = await import("node:fs");
        let tsxPath: string | undefined;
        for (const p of tsxPaths) {
          if (fs2.existsSync(p)) { tsxPath = p; break; }
        }
        if (!tsxPath) {
          // Last resort: try PATH
          const { execSync } = await import("node:child_process");
          try {
            tsxPath = execSync("which tsx", { encoding: "utf-8", env: process.env }).trim();
          } catch {
            throw new Error(`tsx not found. Searched: ${tsxPaths.join(", ")}`);
          }
        }
        runtime = tsxPath;
        args = [gatewayPath];
      }

      this.process = spawn(
        runtime,
        args,
        {
          env: {
            ...process.env,
            GATEWAY_PORT: String(this.port),
            GATEWAY_MODE: "embedded",
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
        this.log.info(`AI Security Gateway started successfully on http://127.0.0.1:${this.port}`);
      } else {
        this.log.warn("AI Security Gateway started but ready signal not received within timeout");
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
