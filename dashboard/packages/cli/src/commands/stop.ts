import fs from "node:fs";
import { paths } from "../lib/paths.js";

export async function stopCommand() {
  if (!fs.existsSync(paths.pid)) {
    console.log("OpenGuardrails Dashboard is not running.");
    return;
  }

  const pid = parseInt(fs.readFileSync(paths.pid, "utf-8").trim(), 10);

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Stopped OpenGuardrails Dashboard (PID: ${pid})`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") {
      console.log("Process not found (already stopped).");
    } else {
      console.error(`Failed to stop process: ${err}`);
    }
  }

  try { fs.unlinkSync(paths.pid); } catch {}
}
