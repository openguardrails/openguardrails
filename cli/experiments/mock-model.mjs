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

/** `{{TOKEN}}` in a scripted argument becomes the first placeholder the model was shown. */
function withToken(args, raw) {
  const token = /OGRK[0-9A-Z][0-9X]{7,}/.exec(raw)?.[0] ?? "NO-PLACEHOLDER-SEEN";
  return JSON.parse(JSON.stringify(args).replaceAll("{{TOKEN}}", token));
}

function resolveCall(body, raw, step) {
  const offered = new Set(toolNames(body));
  const name = step.tool.find((candidate) => offered.has(candidate));
  if (!name) return null;
  // DeepSeek Harness's bash refuses a call with no description.
  return { name, args: withToken(name === "bash" ? { description: "scripted step", ...step.args } : step.args, raw) };
}

function nextStep(body, raw) {
  // A request offering no tools is the harness's own side work, such as naming the session.
  if (toolNames(body).length === 0) return { text: "side reply" };
  const step = script[cursor];
  if (!step) return { text: "done" };
  cursor += 1;
  // Several tools at once: one reply carrying parallel calls.
  if (step.parallel) return { calls: step.parallel.map((one) => resolveCall(body, raw, one)).filter(Boolean) };
  if (!step.tool) return step;
  const call = resolveCall(body, raw, step);
  return call ? { calls: [call] } : { text: `no tool among ${step.tool.join(",")}` };
}

function chatReply(step, stream) {
  const id = `chatcmpl-${Date.now()}`;
  const base = { id, created: Math.floor(Date.now() / 1000), model: "mock" };
  const call = step.calls?.length ? step.calls.map((one, index) => ({ index, id: `call_${cursor}_${index}`, type: "function", function: { name: one.name, arguments: JSON.stringify(one.args) } })) : undefined;
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
      const step = nextStep(body, raw);
      appendFileSync(logPath, `${JSON.stringify({ t: Date.now(), tools: toolNames(body), messages: body.messages?.length, roles: (body.messages ?? []).map((m) => m.role).join(","), lastTool: (body.messages ?? []).filter((m) => m.role === "tool").at(-1)?.content, step, stream: Boolean(body.stream), secretLeft: raw.includes("sk-proj-LABFAKE"), noticeSeen: raw.includes("NOT executed") })}\n`);
      res.writeHead(200, { "content-type": body.stream ? "text/event-stream" : "application/json" });
      res.end(chatReply(step, Boolean(body.stream)));
    });
  })
  .listen(Number(port), "127.0.0.1", () => process.stderr.write(`mock model on ${port}\n`));
