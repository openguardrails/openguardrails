import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";

/** Start a process, save PID, return the child */
export function startProcess(opts: {
  entry: string;
  pidFile: string;
  env: Record<string, string>;
  label: string;
}): ChildProcess {
  if (!fs.existsSync(opts.entry)) {
    console.error(`Error: ${opts.label} entry point not found: ${opts.entry}`);
    console.error("The package may not be built correctly. Try reinstalling.");
    process.exit(1);
  }

  const child = spawn("node", [opts.entry], {
    env: { ...process.env, ...opts.env },
    stdio: "inherit",
    detached: false,
  });

  if (child.pid) {
    fs.writeFileSync(opts.pidFile, String(child.pid), "utf-8");
  }

  child.on("exit", (code) => {
    try { fs.unlinkSync(opts.pidFile); } catch {}
    if (code !== 0 && code !== null) {
      console.error(`${opts.label} exited with code ${code}`);
    }
  });

  return child;
}

/** Stop a process by PID file */
export function stopProcess(pidFile: string, label: string): boolean {
  if (!fs.existsSync(pidFile)) {
    console.log(`${label} is not running.`);
    return false;
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped ${label} (PID: ${pid})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      console.log(`${label} process not found (already stopped).`);
    } else {
      console.error(`Failed to stop ${label}: ${err}`);
    }
  }

  try { fs.unlinkSync(pidFile); } catch {}
  return true;
}

/** Check if a process is running */
export function isRunning(pidFile: string): { running: boolean; pid?: number } {
  if (!fs.existsSync(pidFile)) {
    return { running: false };
  }

  const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    try { fs.unlinkSync(pidFile); } catch {}
    return { running: false };
  }
}
