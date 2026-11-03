/** What `openguardrails scan` reports. It never carries a secret's value, only where one sits. */

export type AgentKind = "personal" | "coding";

export interface ModelEndpoint {
  /** The provider's name in the agent's own config, or "default" when the agent uses its built-in one. */
  provider: string;
  /** Scheme, host, port and path. Credentials and query strings are dropped. Absent for a built-in default. */
  base_url?: string;
  through_gateway: boolean;
  declared_in: string;
}

export interface PackageRef {
  ecosystem: "npm" | "pypi" | "docker";
  name: string;
  version?: string;
  /** An exact version or digest. A range, a tag such as `latest`, or nothing at all is not pinned. */
  pinned: boolean;
}

export interface Component {
  kind: "mcp_server" | "skill" | "plugin";
  name: string;
  transport?: "stdio" | "http";
  package?: PackageRef;
  /** The program a stdio server starts, without its arguments, which can carry secrets. */
  command?: string;
  url?: string;
  /** Where a skill or plugin lives on disk. */
  path?: string;
  /** sha256 of a local script, or of a skill or plugin directory's files. */
  sha256?: string;
  enabled?: boolean;
  declared_in: string;
}

export interface Agent {
  id: string;
  name: string;
  kind: AgentKind;
  open_source: boolean;
  /** The executable on PATH, when there is one. */
  binary?: string;
  config_files: string[];
  models: ModelEndpoint[];
  components: Component[];
}

export interface Finding {
  id: "gateway.not_attached" | "config.plaintext_secret" | "mcp.unpinned_package";
  severity: "low" | "medium" | "high";
  agent: string;
  component?: string;
  /** A file, and for a secret the key path inside it. Never the value. */
  location: string;
  message: string;
}

export interface Inventory {
  scanned_at: string;
  platform: NodeJS.Platform;
  gateway_port: number;
  agents: Agent[];
  findings: Finding[];
}

/** Where an adapter looks. Tests point every path at a fixture. */
export interface ScanContext {
  home: string;
  env: NodeJS.ProcessEnv;
  gatewayPort: number;
}
