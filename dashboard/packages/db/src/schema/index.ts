import { getDialect } from "../dialect.js";

const dialect = getDialect();

// Dynamic schema loading based on dialect
// Using top-level await (Node 22+)
const mod = dialect === "sqlite"
  ? await import("./sqlite.js")
  : dialect === "mysql"
    ? await import("./mysql.js")
    : await import("./pg.js");

export const settings = mod.settings;
export const agents = mod.agents;
export const scannerDefinitions = mod.scannerDefinitions;
export const policies = mod.policies;
export const usageLogs = mod.usageLogs;
export const detectionResults = mod.detectionResults;
export const toolCallObservations = mod.toolCallObservations;
export const agentCapabilities = mod.agentCapabilities;
