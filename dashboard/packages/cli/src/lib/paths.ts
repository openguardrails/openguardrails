import path from "node:path";
import os from "node:os";

const base = path.join(os.homedir(), ".openguardrails");

export const paths = {
  base,
  data: path.join(base, "data"),
  log: path.join(base, "logs"),
  db: path.join(base, "data", "openguardrails.db"),
  config: path.join(base, "config.json"),
  pid: path.join(base, "dashboard.pid"),
};
