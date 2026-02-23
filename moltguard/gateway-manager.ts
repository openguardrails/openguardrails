/**
 * AI Security Gateway process manager for the OpenGuardrails plugin
 *
 * Manages the lifecycle of the AI Security Gateway process.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync } from "node:fs";
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
  private stateFilePath: string;
  private logFilePath: string;
  private adopted = false;

  constructor(options: GatewayOptions, logger: Logger) {
    this.port = options.port;
    this.autoStart = options.autoStart;
    this.log = logger;
    const stateDir = join(
      process.env.HOME || process.env.USERPROFILE || ".",
      ".openclaw", "extensions", "openguardrails",
    );
    this.stateFilePath = join(stateDir, "gateway.state.json");
    this.logFilePath = join(stateDir, "gateway.log");
  }

  /**
   * Start the gateway process
   */
  async start(): Promise<void> {
    if (this.process || this.adopted) {
      this.log.warn("Gateway already running");
      return;
    }

    if (!this.autoStart) {
      this.log.info("Gateway autoStart disabled, skipping");
      return;
    }

    // Check if an existing gateway is already serving on the port
    if (await this.healthCheck()) {
      this.log.info(`Gateway already running on port ${this.port} (adopted existing process)`);
      this.adopted = true;
      this.isReady = true;
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

      // Write stdout/stderr to a log file instead of pipes.
      // Pipes break when the parent exits, causing EPIPE crashes in the child.
      const logDir = dirname(this.stateFilePath);
      mkdirSync(logDir, { recursive: true });
      const logFd = openSync(this.logFilePath, "w");

      this.process = spawn(
        runtime,
        args,
        {
          env: {
            ...process.env,
            GATEWAY_PORT: String(this.port),
            GATEWAY_MODE: "embedded",
          },
          stdio: ["ignore", logFd, logFd],
          detached: true,
        },
      );

      // Close the fd from parent side — child keeps its own copy
      closeSync(logFd);

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

      // Allow parent to exit without waiting for this child
      this.process.unref();

      // Poll health endpoint for readiness instead of parsing stdout
      const ready = await this.waitForHealthy(10000);
      if (ready) {
        this.saveState();
        this.log.info(`AI Security Gateway started successfully on http://127.0.0.1:${this.port}`);
      } else {
        this.log.warn("AI Security Gateway started but health check not passing within timeout");
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
    this.log.info("Stopping gateway...");

    if (this.process) {
      await new Promise<void>((resolve) => {
        this.process!.once("exit", () => {
          this.log.info("Gateway stopped");
          this.process = null;
          resolve();
        });
        this.process!.kill("SIGTERM");
        setTimeout(() => {
          if (this.process) {
            this.log.warn("Gateway did not stop gracefully, forcing kill");
            this.process.kill("SIGKILL");
          }
        }, 5000);
      });
    } else {
      // Kill by PID from state file (adopted or orphaned process)
      const state = this.readState();
      if (state?.pid && this.isProcessAlive(state.pid)) {
        try {
          process.kill(state.pid, "SIGTERM");
          await new Promise((r) => setTimeout(r, 2000));
          if (this.isProcessAlive(state.pid)) {
            process.kill(state.pid, "SIGKILL");
          }
          this.log.info("Gateway stopped (by PID)");
        } catch {
          this.log.warn("Failed to kill gateway process by PID");
        }
      }
    }

    this.isReady = false;
    this.adopted = false;
    this.removeState();
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
    return (this.process !== null || this.adopted) && this.isReady;
  }

  /**
   * Get gateway status
   */
  getStatus(): { running: boolean; port: number; ready: boolean } {
    return {
      running: this.process !== null || this.adopted,
      port: this.port,
      ready: this.isReady,
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
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.stateFilePath, JSON.stringify({
        pid: this.process?.pid,
        port: this.port,
      }));
    } catch {}
  }

  private readState(): { pid?: number; port?: number } | null {
    try {
      if (!existsSync(this.stateFilePath)) return null;
      return JSON.parse(readFileSync(this.stateFilePath, "utf-8"));
    } catch {
      return null;
    }
  }

  private removeState(): void {
    try {
      if (existsSync(this.stateFilePath)) unlinkSync(this.stateFilePath);
    } catch {}
  }
}
