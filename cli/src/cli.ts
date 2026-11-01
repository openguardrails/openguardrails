#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./config.js";
import { latestRun, readRun, renderEvent } from "./record.js";
import { connect } from "./connect.js";
import { run } from "./run.js";
import { serve, status, stop } from "./serve.js";

const USAGE = `openguardrails: AI agent guardrails for every builder

  openguardrails connect [--url <url>]   turn on the model: get a free key, and show where to claim more
  openguardrails decisions               print what the rules and the model decided, newest last
  openguardrails run [options] -- <command...>   run a command and everything it spawns inside the sandbox
  openguardrails log [run-id]                    print what a run did (default: the latest)
  openguardrails status                          check the gateway, every upstream and AIRS; exit 1 on a problem
  openguardrails serve                           run the local service in the foreground (\`run\` starts it for you)
  openguardrails stop                            stop the local service, for instance after editing the config

run options:
  --enforce              deny every host not allowed, instead of recording it
  --allow-host <host>    allow a host; an IP needs a port (--allow-host 10.0.0.5:8888)
  --deny-host <host>     deny a host in every mode
  --allow-read <path>    re-open a credential path that is denied by default
  --allow-write <path>   allow writes outside the project, temp and agent state directories
  --allow-local-bind     let the command listen on a local port, for agents with a web UI

Configuration is ~/.openguardrails/config.json. See the README.
`;

function parseRun(args: string[]) {
  const options = { enforce: false, allowLocalBinding: false, allowHosts: [] as string[], denyHosts: [] as string[], allowRead: [] as string[], allowWrite: [] as string[], command: [] as string[] };
  const lists: Record<string, string[]> = {
    "--allow-host": options.allowHosts,
    "--deny-host": options.denyHosts,
    "--allow-read": options.allowRead,
    "--allow-write": options.allowWrite,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--") {
      options.command = args.slice(i + 1);
      break;
    }
    if (arg === "--enforce") {
      options.enforce = true;
      continue;
    }
    if (arg === "--allow-local-bind") {
      options.allowLocalBinding = true;
      continue;
    }
    const list = lists[arg];
    const value = args[i + 1];
    if (!list || value === undefined) throw new Error(`unknown or incomplete option: ${arg}`);
    list.push(value);
    i += 1;
  }
  if (options.command.length === 0) throw new Error("nothing to run: openguardrails run -- <command...>");
  return options;
}

async function main(argv: string[]): Promise<number> {
  const [verb, ...rest] = argv;
  if (verb === "run") return run(parseRun(rest));
  if (verb === "serve") return serve();
  if (verb === "status") return status();
  if (verb === "stop") return stop();
  if (verb === "connect") {
    const at = rest.indexOf("--url");
    return connect(at >= 0 ? rest[at + 1] : undefined);
  }
  if (verb === "decisions") {
    const path = join(homeDir(), "decisions.ndjson");
    if (existsSync(path)) process.stdout.write(readFileSync(path, "utf8"));
    return 0;
  }
  if (verb === "log") {
    const runId = rest[0] ?? latestRun();
    if (!runId) throw new Error("no runs recorded yet");
    for (const event of readRun(runId)) console.log(renderEvent(event));
    return 0;
  }
  process.stdout.write(USAGE);
  return verb && verb !== "help" && verb !== "--help" ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    // Refusing is the rule: a command that starts without the firewall only looks protected.
    process.stderr.write(`[openguardrails] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
