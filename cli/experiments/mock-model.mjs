#!/usr/bin/env node
/**
 * A scripted model API for driving real agent harnesses without a model, a key or any spend.
 * Each request gets the next reply in the script. A step names a tool by a list of candidate
 * names, resolved against the tools the harness actually offered, so one script fits every harness.
 *
 *   node mock-model.mjs <port> <log.ndjson> [script.json]
 * Script: [{ "tool": ["terminal", "exec"], "args": { "command": "ls" } }, { "text": "done" }]
 * With no script, or past its end, it answers with text and ends the turn.
 */
import { appendFileSync, readFileSync } from "node:fs";
import http from "node:http";

const [port, logPath, scriptPath] = process.argv.slice(2);
const script = scriptPath ? JSON.parse(readFileSync(scriptPath, "utf8")) : [];
let cursor = 0;

const toolNames = (body) => (body.tools ?? []).map((t) => t.function?.name ?? t.name).filter(Boolean);

function nextStep(body) {
  // A request offering no tools is the harness's own side work, such as naming the session.
  if (toolNames(body).length === 0) return { text: "side reply" };
  const step = script[cursor];
  if (!step) return { text: "done" };
  cursor += 1;
  if (!step.tool) return step;
  const offered = new Set(toolNames(body));
  const name = step.tool.find((candidate) => offered.has(candidate));
  // DeepSeek Harness's bash refuses a call with no description.
  if (name === "bash") return { name, args: { description: "scripted step", ...step.args } };
  return name ? { name, args: step.args } : { text: `no tool among ${step.tool.join(",")}` };
}

function chatReply(step, stream) {
  const id = `chatcmpl-${Date.now()}`;
  const base = { id, created: Math.floor(Date.now() / 1000), model: "mock" };
  const call = step.name ? [{ index: 0, id: `call_${cursor}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } }] : undefined;
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
  if (!stream) {
    return JSON.stringify({ ...base, object: "chat.completion", usage, choices: [{ index: 0, finish_reason: call ? "tool_calls" : "stop", message: { role: "assistant", content: step.text ?? null, ...(call ? { tool_calls: call } : {}) } }] });
  }
  const frame = (choice, extra = {}) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [choice], ...extra })}\n\n`;
  return (
    frame({ index: 0, delta: { role: "assistant", content: step.text ?? "" }, finish_reason: null }) +
    (call ? frame({ index: 0, delta: { tool_calls: call }, finish_reason: null }) : "") +
    frame({ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }) +
    `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage })}\n\n` +
    "data: [DONE]\n\n"
  );
}

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (part) => (raw += part));
    req.on("end", () => {
      const url = req.url ?? "";
      if (req.method === "GET" && url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model", context_length: 200000 }] }));
        return;
      }
      if (req.method !== "POST" || !url.endsWith("/chat/completions")) {
        appendFileSync(logPath, `${JSON.stringify({ unhandled: `${req.method} ${url}` })}\n`);
        res.writeHead(404).end("{}");
        return;
      }
      const body = JSON.parse(raw || "{}");
      const step = nextStep(body);
      appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), tools: toolNames(body), messages: body.messages?.length, roles: (body.messages ?? []).map((m) => m.role).join(","), lastTool: (body.messages ?? []).filter((m) => m.role === "tool").at(-1)?.content, step, stream: Boolean(body.stream), secretLeft: raw.includes("sk-proj-LABFAKE") })}\n`);
      res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
      res.end(chatReply(step, Boolean(body.stream)));
    });
  })
  .listen(Number(port), "127.0.0.1", () => process.stderr.write(`mock model on ${port}\n`));
