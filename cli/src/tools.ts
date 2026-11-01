/**
 * What a tool call IS, whichever harness made it. The names come from what Hermes 0.20, OpenClaw
 * 2026.6 and DeepSeek Harness 0.2 actually offered a model. A tool not listed is `other`, which goes
 * to the model: a new tool must never be allowed because nobody thought about it.
 */
export type ToolKind = "shell" | "read" | "search" | "write" | "internal" | "other";

const KINDS: Record<string, ToolKind> = {
  // Runs a command.
  terminal: "shell", exec: "shell", bash: "shell",
  // Reads one file.
  read_file: "read", read: "read",
  // Searches under a directory.
  search_files: "search", grep: "search", glob: "search",
  // Changes one named file. `apply_patch` names its files inside the patch, so it stays `other`.
  write_file: "write", write: "write", edit: "write", patch: "write",
  // The agent's own bookkeeping. Nothing leaves the machine and nothing outside its state changes.
  // `memory` is not here: what it stores steers every later session.
  todo: "internal", todo_write: "internal", clarify: "internal",
  skills_list: "internal", skill_view: "internal", session_search: "internal", session_status: "internal",
  get_goal: "internal", update_goal: "internal", create_goal: "internal", exit_plan_mode: "internal",
  list_agents: "internal", agents_list: "internal", job_list: "internal", job_output: "internal",
  sessions_list: "internal", sessions_history: "internal", memory_get: "internal", memory_search: "internal",
};

export const toolKind = (name: string): ToolKind => (Object.hasOwn(KINDS, name) ? KINDS[name]! : "other");

const firstString = (args: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
};

export const commandOf = (args: Record<string, unknown>) => firstString(args, ["command", "cmd", "script"]);
export const pathOf = (args: Record<string, unknown>) => firstString(args, ["path", "file_path", "filePath", "file", "target"]);

/** The command as one shell line. Some harnesses send `{"command": ["ls", "-la"]}`. */
export function shellLine(args: Record<string, unknown>): string | null {
  if (Array.isArray(args.command) && args.command.every((part) => typeof part === "string")) {
    return args.command.map((part: string) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`)).join(" ");
  }
  return commandOf(args);
}
