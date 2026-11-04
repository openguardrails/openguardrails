#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homeDir } from "./config.js";
import { latestRun, readRun, renderEvent } from "./record.js";
import { connect } from "./connect.js";
import { attachCommand, detach } from "./attach.js";
import { loadConfig } from "./config.js";
import { run } from "./run.js";
import { render, scan } from "./scan/index.js";
import { ensureGateway, hydrateEnv, serve, status, stop } from "./serve.js";
import { notify } from "./notify.js";
import { hostname } from "node:os";

const USAGE = `openguardrails: AI agent guardrails for every builder

  openguardrails connect [--url <url>]   turn on the model: get a free key, and show where to claim more
  openguardrails decisions               print what the rules and the model decided, newest last
  openguardrails scan [--json]           list the agents on this machine, what they load, and what to fix
  openguardrails attach <agent...|--all> [--dry-run]   send an agent's model calls through the gateway
  openguardrails detach <agent...|--all>        put an agent's old base URLs back
  openguardrails run [options] -- <command...>   run a command and everything it spawns inside the sandbox
  openguardrails log [run-id]                    print what a run did (default: the latest)
  openguardrails status                          check the gateway, every upstream and AIRS; exit 1 on a problem
  openguardrails notify test [channel]           send a test message to the channels in notify
  openguardrails serve                           run the local service in the foreground (\`run\` starts it for you)
  openguardrails stop                            stop the local service, for instance after editing the config

run options:
  --enforce              deny every host not allowed, instead of recording it
  --allow-host <host>    allow a host; an IP needs a port (--allow-host 10.0.0.5:8888)
  --deny-host <host>     deny a host in every mode
  --allow-read <path>    re-open a credential path that is denied by default
  --allow-write <path>   allow writes outside the project, temp and agent state directories
  --allow-local-bind     let the command listen on a local port, for agents with a web UI
  --expose <port>        reach a server the command starts on that port, at 127.0.0.1:<port> on this machine
  --upstream-proxy <url> leave through this machine's own proxy (default: HTTPS_PROXY); the command
                         reaches the internet only through openguardrails, then that proxy

Configuration is ~/.openguardrails/config.json. See the README.
`;

function parseRun(args: string[]) {
  const options = { enforce: false, allowLocalBinding: false, allowHosts: [] as string[], denyHosts: [] as string[], allowRead: [] as string[], allowWrite: [] as string[], expose: [] as number[], upstreamProxy: undefined as string | undefined, command: [] as string[] };
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
    if (arg === "--upstream-proxy") {
      if (!args[i + 1]) throw new Error("--upstream-proxy needs a URL, such as http://127.0.0.1:20171");
      options.upstreamProxy = args[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--expose") {
      const port = Number(args[i + 1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--expose needs a port number, not ${args[i + 1] ?? "nothing"}`);
      options.expose.push(port);
      i += 1;
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
  if (verb === "notify") {
    if (rest[0] !== "test") throw new Error("usage: openguardrails notify test [channel]");
    const settings = loadConfig();
    hydrateEnv(settings);
    const channels = rest[1] ? [rest[1]] : Object.keys(settings.notify ?? {});
    if (channels.length === 0) throw new Error("no channels: add notify.email to the config");
    const failures = await notify(settings, channels, {
      subject: "[OpenGuardrails] test message",
      text: `This is a test from openguardrails on ${hostname()}. Your rules can send messages here.`,
    });
    for (const failure of failures) process.stderr.write(`could not send: ${failure}\n`);
    if (failures.length === 0) process.stdout.write(`sent to ${channels.join(", ")}\n`);
    return failures.length === 0 ? 0 : 1;
  }
  if (verb === "status") return status();
  if (verb === "attach") {
    if (!rest.includes("--all") && rest.every((arg) => arg.startsWith("--"))) throw new Error("name the agents to attach, or --all. `openguardrails scan` lists them");
    const dryRun = rest.includes("--dry-run");
    const { plan, unknown } = attachCommand(rest);
    for (const id of unknown) console.log(`${id}: not found on this machine`);
    for (const change of plan.changes) console.log(`${dryRun ? "would attach" : "attached"}  ${change.agent}  ${change.from}  ->  ${change.to}\n            in ${change.file}`);
    for (const skip of plan.skipped) console.log(`skipped   ${skip.agent} ${skip.provider}: ${skip.reason}`);
    if (plan.changes.length === 0) {
      console.log("Nothing to attach.");
      return unknown.length > 0 ? 1 : 0;
    }
    if (dryRun) return 0;
    await ensureGateway(loadConfig());
    console.log("\nThe gateway is running. Restart each attached agent so it reads its new base URL. `openguardrails detach` undoes this.");
    return 0;
  }
  if (verb === "detach") {
    if (!rest.includes("--all") && rest.length === 0) throw new Error("name the agents to detach, or --all");
    const undone = detach(rest.includes("--all") ? "all" : rest, loadConfig());
    for (const entry of undone) console.log(`detached  ${entry.agent}  ${entry.to}  ->  ${entry.from}\n          in ${entry.file}`);
    if (undone.length === 0) console.log("Nothing was attached.");
    else console.log("\nRestart each agent so it reads its old base URL.");
    return 0;
  }
  if (verb === "scan") {
    const inventory = scan();
    process.stdout.write(rest.includes("--json") ? `${JSON.stringify(inventory, null, 2)}\n` : render(inventory));
    return 0;
  }
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
