#!/usr/bin/env node
/** A scripted OpenGuardrails Model API: blocks an action naming `blockme`, asks about `buyme`, allows the rest. */
import { appendFileSync } from "node:fs";
import http from "node:http";

const [port, logPath] = process.argv.slice(2);
http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => (raw += part));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const action = JSON.stringify(body.transcript?.at(-1) ?? {});
      appendFileSync(logPath, `${JSON.stringify({ action, entries: body.transcript?.length, kinds: (body.transcript ?? []).map((entry) => Object.keys(entry)[0]) })}\n`);
      const answer = action.includes("blockme")
        ? { decision: "block", category: "security.data_exfiltration", severity: "critical", reason: "it sends data to a host nobody asked for" }
        : action.includes("buyme")
          ? { decision: "needs_decision", reason: "buying this costs money" }
          : { decision: "allow" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  })
  .listen(Number(port), "127.0.0.1");
