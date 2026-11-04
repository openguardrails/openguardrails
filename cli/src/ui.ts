/**
 * `openguardrails ui`: a page that shows what the protected agents are doing, from the records this
 * tool already keeps (the gateway's log and each run's record). Nothing is stored for it.
 *
 * It answers "what is it doing right now, and is anything wrong": the model calls with the tools
 * they asked for, where it connected, the files that matter (secrets read, where it writes, what it
 * runs), everything refused, and the stall rules. Routine file activity is counted, not listed.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { homeDir } from "./config.js";

type Event = Record<string, any> & { t?: string | number; type?: string };

const MAX_START = 16 * 1024 * 1024;
const KEEP = 400;

/** Reads a newline-delimited JSON file from where it was last read, starting near its end. */
class Tail {
  private offset = -1;
  private rest = "";
  constructor(readonly path: string) {}
  read(): Event[] {
    if (!existsSync(this.path)) return [];
    const fd = openSync(this.path, "r");
    try {
      const size = fstatSync(fd).size;
      if (this.offset < 0 || size < this.offset) this.offset = Math.max(0, size - MAX_START);
      if (size <= this.offset) return [];
      const out: Event[] = [];
      let start = this.offset;
      while (start < size) {
        const length = Math.min(size - start, 4 * 1024 * 1024);
        const buffer = Buffer.alloc(length);
        const n = readSync(fd, buffer, 0, length, start);
        start += n;
        const lines = (this.rest + buffer.subarray(0, n).toString("utf8")).split("\n");
        this.rest = lines.pop() ?? "";
        for (const line of lines) {
          try {
            out.push(JSON.parse(line) as Event);
          } catch {
            // The first line after a jump into the file, or a partial one.
          }
        }
      }
      this.offset = size;
      return out;
    } finally {
      closeSync(fd);
    }
  }
}

function headLine(path: string): Event | null {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const n = readSync(fd, buffer, 0, buffer.length, 0);
    // A run writes what it set up (devices, GPU) before its start line.
    for (const line of buffer.subarray(0, n).toString("utf8").split("\n").slice(0, 8)) {
      try {
        const event = JSON.parse(line) as Event;
        if (event.type === "start") return event;
      } catch {
        // The cut-off last line.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

const time = (event: Event) => (typeof event.t === "number" ? event.t : Date.parse(String(event.t ?? ""))) || Date.now();
const push = <T>(list: T[], item: T) => {
  list.push(item);
  if (list.length > KEEP) list.splice(0, list.length - KEEP);
};

/** A file whose reading is worth a look: keys, cookies, tokens, credentials. */
export const SENSITIVE = /(^|\/)(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(\.[\w-]+)?)(\/|$)|(^|[\/._-])(secrets?|cookies?|tokens?|credentials?|passwords?|passwd)([\/._-]|$)|\.pem$|\.key$|id_(rsa|ed25519|ecdsa)/i;

/** Source code that only mentions tokens or secrets in its name is not one. */
const CODE = /\.(py|pyc|pyi|js|mjs|cjs|ts|go|rs|c|h|cc|cpp|java|rb|sh|md|rst|html|css)$/i;
export const isSensitive = (path: string) => SENSITIVE.test(path) && !CODE.test(path);

/** Where writes are counted: the directory, cut to four levels so a tree of segments is one line. */
export const writePlace = (path: string) => dirname(path).split("/").slice(0, /^\/(tmp|var\/tmp|private\/tmp)\//.test(path) ? 3 : 5).join("/") || "/";

interface RunState {
  id: string;
  label: string;
  mode: string;
  started: number;
  last: number;
  ended: number | null;
  counts: Record<string, number>;
  hosts: Map<string, { count: number; denied: number; bytesDown: number; last: number }>;
  writes: Map<string, { count: number; last: number }>;
  execs: Map<string, { count: number; last: number }>;
  sensitive: Event[];
  tools: Event[];
  refused: Event[];
  alerts: Event[];
}

export class Activity {
  private gateway: Tail;
  private runs = new Map<string, { tail: Tail; state: RunState }>();
  readonly calls: Event[] = [];
  readonly failovers: Event[] = [];
  readonly gatewayRefused: Event[] = [];
  constructor(private readonly home = homeDir()) {
    this.gateway = new Tail(join(home, "gateway.ndjson"));
  }

  refresh(): void {
    for (const event of this.gateway.read()) {
      if (event.type === "step") push(this.calls, event);
      else if (event.type === "failover" || event.type === "exhausted") push(this.failovers, event);
      else if (event.type === "refused") push(this.gatewayRefused, event);
    }
    const dir = join(this.home, "runs");
    if (!existsSync(dir)) return;
    const files = readdirSync(dir)
      .filter((file) => file.endsWith(".ndjson"))
      .map((file) => ({ file, mtime: statSync(join(dir, file)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 12);
    for (const { file } of files) {
      const id = file.slice(0, -7);
      let entry = this.runs.get(id);
      if (!entry) {
        entry = {
          tail: new Tail(join(dir, file)),
          state: { id, label: id, mode: "", started: 0, last: 0, ended: null, counts: {}, hosts: new Map(), writes: new Map(), execs: new Map(), sensitive: [], tools: [], refused: [], alerts: [] },
        };
        this.runs.set(id, entry);
      }
      // The record's first line names the run; the tail may start long after it.
      if (entry.state.started === 0) {
        const first = headLine(join(dir, file));
        if (first?.type === "start") absorb(entry.state, first);
      }
      for (const event of entry.tail.read()) absorb(entry.state, event);
    }
  }

  snapshot(): unknown {
    const now = Date.now();
    const runs = [...this.runs.values()].map(({ state }) => state).sort((a, b) => b.last - a.last);
    const top = <V extends { last: number }>(map: Map<string, V>, n: number) => [...map.entries()].sort((a, b) => b[1].last - a[1].last).slice(0, n).map(([key, value]) => ({ key, ...value }));
    return {
      now,
      model: {
        recent: this.calls.slice(-60).reverse(),
        lastHour: this.calls.filter((call) => now - time(call) < 3_600_000).length,
        failovers: this.failovers.slice(-10).reverse(),
        refused: this.gatewayRefused.slice(-20).reverse(),
      },
      runs: runs.map((run) => ({
        id: run.id,
        label: run.label,
        mode: run.mode,
        started: run.started,
        last: run.last,
        running: run.ended === null && now - run.last < 30 * 60_000,
        counts: run.counts,
        hosts: top(run.hosts, 25),
        writes: top(run.writes, 15),
        execs: top(run.execs, 20),
        sensitive: run.sensitive.slice(-25).reverse(),
        tools: run.tools.slice(-30).reverse(),
        refused: run.refused.slice(-30).reverse(),
        alerts: run.alerts.slice(-10).reverse(),
      })),
    };
  }
}

export function absorb(run: RunState, event: Event): void {
  const t = time(event);
  run.last = Math.max(run.last, t);
  run.counts[event.type ?? "?"] = (run.counts[event.type ?? "?"] ?? 0) + 1;
  switch (event.type) {
    case "start":
      run.label = String(event.command ?? run.id);
      run.mode = String(event.mode ?? "");
      run.started = t;
      break;
    case "exit":
      run.ended = t;
      break;
    case "connect":
    case "request": {
      if (event.via === "bridge" || (event.host === "127.0.0.1" && event.type === "connect" && event.allowed !== false)) {
        const key = `local :${event.inside ?? event.port}`;
        const host = run.hosts.get(key) ?? { count: 0, denied: 0, bytesDown: 0, last: 0 };
        host.count += 1;
        host.last = t;
        run.hosts.set(key, host);
        break;
      }
      const key = String(event.host ?? "?");
      const host = run.hosts.get(key) ?? { count: 0, denied: 0, bytesDown: 0, last: 0 };
      host.count += 1;
      host.last = t;
      host.bytesDown += Number(event.bytes_down ?? 0);
      if (event.allowed === false) {
        host.denied += 1;
        push(run.refused, { t, what: "network", detail: `${event.host}:${event.port}` });
      }
      run.hosts.set(key, host);
      break;
    }
    case "file": {
      const path = String(event.path ?? "");
      if (event.action === "exec") {
        const exec = run.execs.get(path) ?? { count: 0, last: 0 };
        exec.count += 1;
        exec.last = t;
        run.execs.set(path, exec);
      } else if (event.action === "write") {
        const place = writePlace(path);
        const write = run.writes.get(place) ?? { count: 0, last: 0 };
        write.count += 1;
        write.last = t;
        run.writes.set(place, write);
      }
      if (event.action === "read" && isSensitive(path)) push(run.sensitive, { t, path, process: event.process });
      break;
    }
    case "tool_call":
      push(run.tools, { t, name: event.name, harness: event.harness, hosts: event.hosts });
      break;
    case "violation":
      push(run.refused, { t, what: "sandbox", detail: String(event.line ?? "") });
      break;
    case "broker":
      if (event.refused) push(run.refused, { t, what: event.tool, detail: `${(event.args ?? []).join(" ")}: ${event.refused}` });
      break;
    case "undeclared":
    case "unverified":
      push(run.refused, { t, what: event.type, detail: `${event.host} (${(event.methods ?? []).join("/")})` });
      break;
    case "stalled":
    case "recovered":
    case "notify":
      push(run.alerts, { t, ...event });
      break;
  }
}

export interface UiOptions {
  host: string;
  port: number;
}

export async function ui(options: UiOptions): Promise<number> {
  const token = randomBytes(18).toString("base64url");
  writeFileSync(join(homeDir(), "ui.token"), token, { mode: 0o600 });
  const activity = new Activity();
  activity.refresh();
  const timer = setInterval(() => activity.refresh(), 3000);
  timer.unref();
  const allowed = (given: string | null) => {
    if (!given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://ui");
    if (!allowed(url.searchParams.get("token"))) {
      res.writeHead(401, { "content-type": "text/plain" });
      return void res.end("openguardrails ui: open the address it printed, with its token\n");
    }
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
    if (url.pathname === "/api/state") {
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      return void res.end(JSON.stringify(activity.snapshot()));
    }
    res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
    res.end(PAGE);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  const shown = options.host === "0.0.0.0" || options.host === "::" ? "<this machine's address>" : options.host;
  process.stderr.write(`[openguardrails] ui: http://${shown}:${options.port}/?token=${token}\n`);
  return new Promise<number>(() => undefined);
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenGuardrails · activity</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--mute:#6b6b66;--line:#e6e5e0;--bad:#b42318;--warn:#b54708;--ok:#067647;--accent:#3b5bdb}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecebe6;--mute:#9b9a94;--line:#2e2e2b;--bad:#f97066;--warn:#fdb022;--ok:#47cd89;--accent:#91a7ff}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
header{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
h1{font-size:17px;margin:0}h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:0 0 8px}
main{padding:16px 24px;display:grid;gap:16px;grid-template-columns:repeat(auto-fill,minmax(420px,1fr))}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;min-width:0}
section.wide{grid-column:1/-1}table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--mute);font-weight:500}td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.mono{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all}
.bad{color:var(--bad)}.warn{color:var(--warn)}.ok{color:var(--ok)}.mute{color:var(--mute)}.pill{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:12px;margin-right:6px}
.stat{display:inline-block;margin-right:18px}.stat b{font-size:20px;display:block}select{font:inherit;padding:4px 8px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
.empty{color:var(--mute);font-size:13px}
</style></head><body>
<header><h1>OpenGuardrails · what your agents are doing</h1><span class="mute" id="updated"></span><span style="flex:1"></span><label class="mute">run <select id="run"></select></label></header>
<main id="main"><section class="wide"><span class="empty">Loading…</span></section></main>
<script>
const token = new URLSearchParams(location.search).get("token");
const sel = document.getElementById("run");
let chosen = null;
sel.onchange = () => { chosen = sel.value; draw(last); };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ago = (t) => { const s = Math.max(0, (Date.now() - (typeof t === "number" ? t : Date.parse(t))) / 1000); return s < 60 ? Math.round(s) + "s ago" : s < 3600 ? Math.round(s / 60) + "m ago" : s < 86400 ? Math.round(s / 3600) + "h ago" : Math.round(s / 86400) + "d ago"; };
const ms = (v) => v == null ? "" : v < 1000 ? v + " ms" : (v / 1000).toFixed(1) + " s";
const table = (head, rows) => rows.length ? "<table><tr>" + head.map((h) => "<th>" + h + "</th>").join("") + "</tr>" + rows.join("") + "</table>" : '<p class="empty">Nothing yet.</p>';
let last = null;
async function load() {
  try { const r = await fetch("/api/state?token=" + encodeURIComponent(token)); last = await r.json(); draw(last); }
  catch (e) { document.getElementById("updated").textContent = "cannot reach openguardrails ui"; }
}
function draw(s) {
  if (!s) return;
  document.getElementById("updated").textContent = "updated " + new Date(s.now).toLocaleTimeString();
  const runs = s.runs;
  if (!chosen || !runs.find((r) => r.id === chosen)) chosen = (runs.find((r) => r.running) || runs[0] || {}).id;
  sel.innerHTML = runs.map((r) => '<option value="' + esc(r.id) + '"' + (r.id === chosen ? " selected" : "") + ">" + esc(r.label) + (r.running ? " · running" : "") + " · " + esc(r.id) + "</option>").join("");
  const run = runs.find((r) => r.id === chosen);
  const m = s.model;
  let html = '<section class="wide"><h2>Now</h2>';
  if (run) {
    const c = run.counts;
    html += '<span class="stat"><b class="' + (run.running ? "ok" : "mute") + '">' + (run.running ? "running" : "stopped") + "</b>" + esc(run.label) + "</span>";
    html += '<span class="stat"><b>' + m.lastHour + "</b>model calls, last hour</span>";
    html += '<span class="stat"><b>' + run.hosts.length + "</b>places it connected to</span>";
    html += '<span class="stat"><b class="' + (run.refused.length ? "bad" : "") + '">' + run.refused.length + "</b>refused</span>";
    html += '<span class="stat"><b class="' + (run.alerts.some((a) => a.type === "stalled") ? "warn" : "") + '">' + run.alerts.filter((a) => a.type === "stalled").length + "</b>stalls</span>";
    html += '<span class="stat"><b>' + (c.file || 0) + "</b>file events</span>";
    html += '<p class="mute">last activity ' + ago(run.last) + (run.mode ? " · " + esc(run.mode) + " mode" : "") + "</p>";
  } else html += '<p class="empty">No runs recorded yet.</p>';
  html += "</section>";
  html += '<section class="wide"><h2>Model calls</h2>' + table(["when", "model", "served by", "took", "first byte", "tools it asked for", "tokens", "client"],
    m.recent.map((c) => "<tr><td>" + ago(c.t) + "</td><td>" + esc(c.model) + "</td><td>" + esc(c.upstream) + "</td><td class=n>" + ms(c.ms) + "</td><td class=n>" + ms(c.first_byte_ms) + "</td><td>" + (c.tools || []).map((t) => '<span class="pill">' + esc(t) + "</span>").join("") + "</td><td class=n>" + (c.tokens_in != null ? esc(c.tokens_in) + " → " + esc(c.tokens_out) : "") + '</td><td class="mono mute">' + esc(c.agent_type !== "unknown" ? c.agent_type : c.ua) + "</td></tr>"));
  if (m.failovers.length) html += '<p class="warn">Failovers: ' + m.failovers.map((f) => esc(ago(f.t)) + " → " + esc(f.to || "none") + " (" + esc((f.failed || []).join("; ")) + ")").join(" · ") + "</p>";
  html += "</section>";
  if (run) {
    html += "<section><h2>Refused</h2>" + table(["when", "what", "detail"], run.refused.concat(m.refused.map((r) => ({ t: r.t, what: "model call", detail: r.reason })))
      .map((r) => "<tr><td>" + ago(r.t) + '</td><td class="bad">' + esc(r.what) + '</td><td class="mono">' + esc(r.detail) + "</td></tr>")) + "</section>";
    html += "<section><h2>Stall rules</h2>" + table(["when", "event", "detail"], run.alerts.map((a) => "<tr><td>" + ago(a.t) + '</td><td class="' + (a.type === "stalled" ? "warn" : a.type === "recovered" ? "ok" : "") + '">' + esc(a.type) + '</td><td class="mono">' + esc(a.rule || a.subject || "") + (a.failures && a.failures.length ? ' <span class="bad">' + esc(a.failures.join("; ")) + "</span>" : "") + "</td></tr>")) + "</section>";
    html += "<section><h2>Where it connected</h2>" + table(["destination", "connections", "down", "last"], run.hosts.map((h) => "<tr><td class=mono>" + esc(h.key) + (h.denied ? ' <span class="bad">' + h.denied + " refused</span>" : "") + "</td><td class=n>" + h.count + "</td><td class=n>" + (h.bytesDown ? (h.bytesDown / 1e6).toFixed(1) + " MB" : "") + "</td><td>" + ago(h.last) + "</td></tr>")) + "</section>";
    html += "<section><h2>Secrets and credentials it read</h2>" + table(["when", "file", "by"], run.sensitive.map((f) => "<tr><td>" + ago(f.t) + '</td><td class="mono warn">' + esc(f.path) + '</td><td class="mono">' + esc(f.process) + "</td></tr>")) + "</section>";
    html += "<section><h2>Tool calls</h2>" + table(["when", "tool", "names"], run.tools.map((t) => "<tr><td>" + ago(t.t) + "</td><td>" + esc(t.name) + '</td><td class="mono">' + esc((t.hosts || []).join(", ")) + "</td></tr>")) + "</section>";
    html += "<section><h2>Programs it ran</h2>" + table(["program", "times", "last"], run.execs.map((e) => '<tr><td class="mono">' + esc(e.key) + "</td><td class=n>" + e.count + "</td><td>" + ago(e.last) + "</td></tr>")) + "</section>";
    html += "<section><h2>Where it writes</h2>" + table(["directory", "files", "last"], run.writes.map((w) => '<tr><td class="mono">' + esc(w.key) + "</td><td class=n>" + w.count + "</td><td>" + ago(w.last) + "</td></tr>")) + "</section>";
  }
  document.getElementById("main").innerHTML = html;
}
load(); setInterval(load, 5000);
</script></body></html>`;
