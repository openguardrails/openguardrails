// GENERATED — do not edit. Source: integrations/agent/ogr-local/src
// Rebuild: npm --prefix integrations/agent/ogr-local run bundle
// OGR_LOCAL_SOURCE_STAMP=0a43582b0484
// version=0.1.0

// src/bundle.ts
import { pathToFileURL } from "node:url";

// ../local-redaction/dist/ruleset.js
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var DEFAULT_TIERS = ["strong", "heuristic"];
function ruleSpans(rule, text) {
  const out = [];
  for (const p of rule.patterns) {
    p.re.lastIndex = 0;
    let m;
    while ((m = p.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        p.re.lastIndex += 1;
        continue;
      }
      let span;
      if (rule.group !== void 0) {
        const g = m.indices?.[rule.group];
        if (g)
          span = { start: g[0], end: g[1] };
      } else {
        span = { start: m.index, end: m.index + m[0].length };
      }
      if (span && span.end > span.start)
        out.push({ ...span, pattern: p.id });
    }
  }
  return out;
}
function engineFlags(rule) {
  const wanted = new Set(rule.flags.split(""));
  wanted.add("g");
  if (rule.group)
    wanted.add("d");
  return [...wanted].join("");
}
function compileRuleset(ruleset, opts = {}) {
  const tiers = new Set(opts.tiers ?? DEFAULT_TIERS);
  const rules = [];
  const disabled = [];
  const skipped = [];
  for (const rule of ruleset.rules) {
    if (!tiers.has(rule.tier)) {
      skipped.push(rule.id);
      continue;
    }
    const group = rule.group ? rule.group : void 0;
    const patterns = [];
    let failure = null;
    for (const p of rule.patterns) {
      try {
        patterns.push({ id: p.id, re: new RegExp(p.source, engineFlags(rule)) });
      } catch (err) {
        failure = `pattern ${p.id} does not compile: ${String(err)}`;
        break;
      }
    }
    const compiled = { id: rule.id, category: rule.category, tier: rule.tier, group, patterns };
    if (!failure)
      failure = verifyExamples(compiled, rule.examples);
    if (failure) {
      disabled.push({ id: rule.id, reason: failure });
      opts.log?.(`[openguardrails] local redaction: rule ${rule.id} disabled \u2014 ${failure}`);
      continue;
    }
    rules.push(compiled);
  }
  return { id: ruleset.id, dialect: ruleset.dialect, rules, disabled, skipped };
}
function verifyExamples(rule, examples) {
  for (const text of examples?.match ?? []) {
    if (ruleSpans(rule, text).length === 0)
      return `match example yielded no span: ${JSON.stringify(text)}`;
  }
  for (const text of examples?.nomatch ?? []) {
    if (ruleSpans(rule, text).length > 0)
      return `nomatch example yielded a span: ${JSON.stringify(text)}`;
  }
  return null;
}
function defaultCachePath(runtimeUrl) {
  const key = createHash("sha256").update(runtimeUrl).digest("hex").slice(0, 8);
  return join(homedir(), ".openguardrails", `rules-${key}.json`);
}
function readCachedRuleset(cachePath) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"));
    return isRuleset(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function writeCachedRuleset(cachePath, ruleset) {
  mkdirSync(dirname(cachePath), { recursive: true, mode: 448 });
  const tmp = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(ruleset), { mode: 384 });
  chmodSync(tmp, 384);
  renameSync(tmp, cachePath);
}
function isRuleset(x) {
  if (typeof x !== "object" || x === null)
    return false;
  const r = x;
  return typeof r["id"] === "string" && r["id"].length > 0 && Array.isArray(r["rules"]);
}
async function loadRuleset(opts) {
  const cachePath = opts.cachePath ?? defaultCachePath(opts.runtimeUrl);
  const cached = readCachedRuleset(cachePath);
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const base = opts.runtimeUrl.endsWith("/") ? opts.runtimeUrl.slice(0, -1) : opts.runtimeUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 5e3);
  try {
    const headers = { authorization: `Bearer ${opts.apiKey}`, accept: "application/json" };
    if (cached)
      headers["if-none-match"] = `"${cached.id}"`;
    const res = await fetchImpl(`${base}/v1/rules`, { method: "GET", headers, signal: controller.signal });
    if (res.status === 304 && cached)
      return { ruleset: cached, source: "cached" };
    if (!res.ok) {
      return { ruleset: cached, source: cached ? "cached" : "none", error: `rules answered ${res.status}` };
    }
    const body = await res.json();
    const ruleset = body?.ruleset;
    if (!isRuleset(ruleset)) {
      return { ruleset: cached, source: cached ? "cached" : "none", error: "rules answered a body without a ruleset" };
    }
    try {
      writeCachedRuleset(cachePath, ruleset);
    } catch (err) {
      return { ruleset, source: "fetched", error: `cache not written: ${String(err)}` };
    }
    return { ruleset, source: "fetched" };
  } catch (err) {
    return { ruleset: cached, source: cached ? "cached" : "none", error: `rules fetch failed: ${String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

// ../local-redaction/dist/session.js
var SECRET_TOKEN_PREFIX = "${OGR_SECRET_";
var OVERFLOW_TOKEN = "${OGR_SECRET_X}";
var DEFAULT_BOUND = 256;
var SessionMap = class {
  id;
  byValue = /* @__PURE__ */ new Map();
  byToken = /* @__PURE__ */ new Map();
  counter = 0;
  warnedFull = false;
  valuesLongestFirst = null;
  tokensLongestFirst = null;
  bound;
  warn;
  allocate;
  constructor(id, opts = {}) {
    this.id = id;
    this.bound = opts.bound ?? DEFAULT_BOUND;
    this.warn = opts.warn ?? (() => {
    });
    this.allocate = opts.allocate ?? (() => ++this.counter);
  }
  get size() {
    return this.byValue.size;
  }
  has(value) {
    return this.byValue.has(value);
  }
  /** The token for a value, minting one when the value is new. */
  tokenFor(value) {
    const known = this.byValue.get(value);
    if (known !== void 0)
      return { token: known, fresh: false, restorable: true };
    if (this.byValue.size >= this.bound) {
      if (!this.warnedFull) {
        this.warnedFull = true;
        this.warn(`[openguardrails] local redaction: session ${this.id} holds ${this.bound} secrets \u2014 further values are masked with the non-restorable ${OVERFLOW_TOKEN}`);
      }
      return { token: OVERFLOW_TOKEN, fresh: true, restorable: false };
    }
    const token = `${SECRET_TOKEN_PREFIX}${this.allocate()}}`;
    this.byValue.set(value, token);
    this.byToken.set(token, value);
    this.valuesLongestFirst = null;
    this.tokensLongestFirst = null;
    return { token, fresh: true, restorable: true };
  }
  valueOf(token) {
    return this.byToken.get(token);
  }
  /** Every known value, longest first — the order a value substitution must run in. */
  values() {
    if (!this.valuesLongestFirst) {
      this.valuesLongestFirst = [...this.byValue.keys()].sort((a, b) => b.length - a.length);
    }
    return this.valuesLongestFirst;
  }
  /** Every issued token, longest first — the order a restorer must try keys in. */
  tokens() {
    if (!this.tokensLongestFirst) {
      this.tokensLongestFirst = [...this.byToken.keys()].sort((a, b) => b.length - a.length);
    }
    return this.tokensLongestFirst;
  }
  entries() {
    return this.byToken;
  }
};
var SessionMaps = class {
  maps = /* @__PURE__ */ new Map();
  maxSessions;
  mapOptions;
  issued = 0;
  constructor(opts = {}) {
    this.maxSessions = opts.maxSessions ?? 1024;
    this.mapOptions = {
      ...opts.bound !== void 0 ? { bound: opts.bound } : {},
      ...opts.warn ? { warn: opts.warn } : {},
      allocate: opts.allocate ?? (() => ++this.issued)
    };
  }
  get(sessionId) {
    let map = this.maps.get(sessionId);
    if (map) {
      this.maps.delete(sessionId);
      this.maps.set(sessionId, map);
      return map;
    }
    if (this.maps.size >= this.maxSessions) {
      const oldest = this.maps.keys().next();
      if (!oldest.done)
        this.maps.delete(oldest.value);
    }
    map = new SessionMap(sessionId, this.mapOptions);
    this.maps.set(sessionId, map);
    return map;
  }
  peek(sessionId) {
    return this.maps.get(sessionId);
  }
  drop(sessionId) {
    this.maps.delete(sessionId);
  }
  get size() {
    return this.maps.size;
  }
};

// ../local-redaction/dist/mask.js
var TOKEN_RE = /\$\{OGR_[A-Z_]+_[0-9A-Z]+\}/g;
var STRIP_ONE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060\ufeff]/;
function normalize(text) {
  if (!STRIP_ONE.test(text))
    return { stripped: text, index: null };
  const chars = [];
  const index = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (STRIP_ONE.test(ch))
      continue;
    chars.push(ch);
    index.push(i);
  }
  return { stripped: chars.join(""), index };
}
function overlapsAny(span, spans) {
  for (const s of spans)
    if (span.start < s.end && s.start < span.end)
      return true;
  return false;
}
function tokenRanges(text) {
  const out = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(text)) !== null)
    out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}
function mask(text, map, compiled) {
  if (text === "")
    return { text, minted: [] };
  const { stripped, index } = normalize(text);
  const tokens = tokenRanges(stripped);
  const accepted = [];
  for (const value of map.values()) {
    if (value === "")
      continue;
    const token = map.tokenFor(value).token;
    let at = stripped.indexOf(value);
    while (at !== -1) {
      const span = { start: at, end: at + value.length };
      if (!overlapsAny(span, tokens) && !overlapsAny(span, accepted))
        accepted.push({ ...span, token });
      at = stripped.indexOf(value, span.end);
    }
  }
  const minted = [];
  if (compiled && compiled.rules.length > 0) {
    const candidates = [];
    for (const rule of compiled.rules) {
      for (const s of ruleSpans(rule, stripped)) {
        if (overlapsAny(s, tokens))
          continue;
        candidates.push({ start: s.start, end: s.end, rule: `${rule.id}/${s.pattern}`, order: candidates.length });
      }
    }
    candidates.sort((a, b) => b.end - b.start - (a.end - a.start) || a.order - b.order);
    const chosen = [];
    for (const c of candidates) {
      if (overlapsAny(c, accepted) || overlapsAny(c, chosen))
        continue;
      chosen.push(c);
    }
    chosen.sort((a, b) => a.start - b.start);
    const seen = /* @__PURE__ */ new Set();
    for (const c of chosen) {
      const value = stripped.slice(c.start, c.end);
      const grant = map.tokenFor(value);
      accepted.push({ start: c.start, end: c.end, token: grant.token });
      if (grant.fresh && !seen.has(grant.token)) {
        seen.add(grant.token);
        minted.push({ token: grant.token, rule: c.rule });
      }
    }
  }
  if (accepted.length === 0)
    return { text, minted };
  accepted.sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const r of accepted) {
    const os = index ? index[r.start] : r.start;
    const oe = index ? index[r.end - 1] + 1 : r.end;
    out += text.slice(cursor, os) + r.token;
    cursor = oe;
  }
  out += text.slice(cursor);
  return { text: out, minted };
}
var STRUCTURAL_KEYS = /* @__PURE__ */ new Set([
  "role",
  "type",
  "id",
  "model",
  "name",
  "object",
  "status",
  "finish_reason",
  "stop_reason",
  "stopReason",
  "tool_call_id",
  "tool_use_id",
  "call_id",
  "callID",
  "sessionID",
  "messageID",
  "toolCallId",
  "toolName",
  "tool",
  "provider",
  "api",
  "mimeType",
  "media_type",
  "textSignature",
  "thinkingSignature"
]);
function isImageBlock(obj) {
  const t = obj["type"];
  return t === "image" || t === "image_url" || t === "input_image" || typeof obj["mimeType"] === "string";
}
function maskLeaves(value, map, compiled) {
  const minted = [];
  let changed = false;
  const walk = (v, key, parent) => {
    if (typeof v === "string") {
      if (key !== null && STRUCTURAL_KEYS.has(key))
        return v;
      if (key === "data" && parent && isImageBlock(parent))
        return v;
      const r = mask(v, map, compiled);
      if (r.text !== v)
        changed = true;
      minted.push(...r.minted);
      return r.text;
    }
    if (Array.isArray(v))
      return v.map((item) => walk(item, null, null));
    if (typeof v === "object" && v !== null) {
      const src = v;
      const out2 = {};
      for (const k of Object.keys(src))
        out2[k] = walk(src[k], k, src);
      return out2;
    }
    return v;
  };
  const out = walk(value, null, null);
  return { value: changed ? out : value, minted, changed };
}
function maskKnown(value, map) {
  return maskLeaves(value, map, null);
}

// ../local-redaction/dist/restore.js
var ESCAPABLE = /* @__PURE__ */ new Set(["_", "*", "$", "{", "}", "[", "]", "(", ")", "#", "+", "-", ".", "!", "`", "~", "|", "<", ">", "\\"]);
var MATCH_NONE = 0;
var MATCH_FULL = 1;
var MATCH_TRUNCATED = 2;
function matchKey(text, i, key) {
  let p = i;
  for (let k = 0; k < key.length; k += 1) {
    if (p >= text.length)
      return [0, MATCH_TRUNCATED];
    if (text[p] === "\\" && key[k] !== "\\") {
      if (p + 1 >= text.length)
        return [0, MATCH_TRUNCATED];
      if (ESCAPABLE.has(text[p + 1]))
        p += 1;
    }
    if (text[p] !== key[k])
      return [0, MATCH_NONE];
    p += 1;
  }
  return [p - i, MATCH_FULL];
}
var TOKEN_SHAPE_RE = /\\?\$\\?\{OGR(?:\\?_[A-Z]+)*\\?_[0-9A-Z]+\\?\}/g;
function tokensIn(text) {
  const out = /* @__PURE__ */ new Set();
  TOKEN_SHAPE_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_SHAPE_RE.exec(text)) !== null)
    out.add(m[0].replaceAll("\\", ""));
  return [...out];
}
var jsonStringEncode = (value) => JSON.stringify(value).slice(1, -1);
function createStreamRestorer(map, opts = {}) {
  const encode = opts.encode ?? ((v) => v);
  const matchAt = (keys, text, i) => {
    let partial = false;
    for (const k of keys) {
      const [raw, status] = matchKey(text, i, k);
      if (status === MATCH_FULL)
        return [k, raw, false];
      if (status === MATCH_TRUNCATED)
        partial = true;
    }
    return ["", 0, partial];
  };
  const extract = (text, isLast) => {
    const keys = map.tokens();
    if (keys.length === 0 || text === "")
      return { output: text, pending: "" };
    const starts = /* @__PURE__ */ new Set(["\\"]);
    let longest = 0;
    for (const k of keys) {
      starts.add(k[0]);
      if (k.length > longest)
        longest = k.length;
    }
    const maxRaw = longest * 2 + 2;
    const parts = [];
    let flushed = 0;
    let i = 0;
    while (i < text.length) {
      if (!starts.has(text[i])) {
        i += 1;
        continue;
      }
      const [key, raw, partial] = matchAt(keys, text, i);
      if (raw > 0) {
        parts.push(text.slice(flushed, i), encode(map.valueOf(key)));
        i += raw;
        flushed = i;
        continue;
      }
      if (partial && !isLast && text.length - i <= maxRaw) {
        parts.push(text.slice(flushed, i));
        return { output: parts.join(""), pending: text.slice(i) };
      }
      i += 1;
    }
    parts.push(text.slice(flushed));
    return { output: parts.join(""), pending: "" };
  };
  return {
    extract,
    feed(state, text, isLast) {
      const { output, pending } = extract(state.pending + text, isLast);
      state.pending = pending;
      return output;
    },
    get active() {
      return map.tokens().length > 0;
    }
  };
}
function restore(text, map, opts = {}) {
  const out = text === "" ? text : createStreamRestorer(map, opts).extract(text, true).output;
  const unresolved = tokensIn(out).filter((t) => map.valueOf(t) === void 0);
  return { text: out, unresolved };
}
function restoreJsonText(text, map) {
  return restore(text, map, { encode: jsonStringEncode });
}
function restoreArgs(args, map) {
  const unresolved = /* @__PURE__ */ new Set();
  let changed = false;
  const walk = (v) => {
    if (typeof v === "string") {
      const r = restore(v, map);
      for (const t of r.unresolved)
        unresolved.add(t);
      if (r.text !== v)
        changed = true;
      return r.text;
    }
    if (Array.isArray(v))
      return v.map(walk);
    if (typeof v === "object" && v !== null) {
      const src = v;
      const out2 = {};
      for (const k of Object.keys(src))
        out2[k] = walk(src[k]);
      return out2;
    }
    return v;
  };
  const out = walk(args);
  return { args: changed ? out : args, unresolved: [...unresolved], changed };
}
function restoreArgsAcross(args, maps) {
  let current = args;
  let changed = false;
  let unresolved = restoreArgs(args, EMPTY_MAP).unresolved;
  for (const map of maps) {
    const r = restoreArgs(current, map);
    current = r.args;
    changed = changed || r.changed;
    unresolved = r.unresolved;
  }
  return { args: current, unresolved, changed };
}
var EMPTY_MAP = { tokens: () => [], valueOf: () => void 0 };

// ../local-redaction/dist/protocol.js
var DEFAULT_MODEL_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  // Codex's backend when the user is signed in with ChatGPT rather than an
  // API key (`CHATGPT_CODEX_BASE_URL` in `codex-rs/model-provider-info`).
  // It speaks `openai.responses` like the API-key endpoint does.
  "chatgpt.com",
  "openrouter.ai",
  "generativelanguage.googleapis.com"
];
var DEFAULT_MODEL_HOST_SUFFIXES = [".openai.azure.com"];
function isModelHost(hostname, extra = []) {
  const h = hostname.toLowerCase();
  if (DEFAULT_MODEL_HOSTS.includes(h) || extra.some((x) => x.toLowerCase() === h))
    return true;
  return DEFAULT_MODEL_HOST_SUFFIXES.some((s) => h.endsWith(s));
}
var asDict = (v) => typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
var asArray = (v) => Array.isArray(v) ? v : [];
function anthropicShaped(body) {
  if (body["system"] !== void 0)
    return true;
  const tools = asArray(body["tools"]).map(asDict);
  if (tools.some((t) => t && t["input_schema"] !== void 0))
    return true;
  return asArray(body["messages"]).some((m) => asArray(asDict(m)?.["content"]).some((b) => {
    const t = asDict(b)?.["type"];
    return t === "tool_use" || t === "tool_result" || t === "thinking" || t === "redacted_thinking";
  }));
}
function sniffProtocol(body, url) {
  const b = asDict(body);
  if (!b)
    return null;
  const path = url?.pathname ?? "";
  if (path.endsWith("/count_tokens"))
    return null;
  const messages = Array.isArray(b["messages"]);
  if (messages) {
    if (path.endsWith("/messages"))
      return "anthropic.messages";
    if (path.endsWith("/chat/completions"))
      return "openai.chat";
    return anthropicShaped(b) ? "anthropic.messages" : "openai.chat";
  }
  if (path.endsWith("/responses") && (b["input"] !== void 0 || b["instructions"] !== void 0))
    return "openai.responses";
  if (b["input"] !== void 0 && typeof b["model"] === "string")
    return "openai.responses";
  if (typeof b["instructions"] === "string" && typeof b["model"] === "string")
    return "openai.responses";
  return null;
}
function stampedSession(body) {
  const b = asDict(body);
  if (!b)
    return null;
  if (typeof b["user"] === "string" && b["user"] !== "")
    return b["user"];
  const uid = asDict(b["metadata"])?.["user_id"];
  return typeof uid === "string" && uid !== "" ? uid : null;
}
function restoreResponseBody(protocol, text, map) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const body = asDict(parsed);
  if (!body)
    return null;
  let changed = false;
  const unresolved = /* @__PURE__ */ new Set();
  const jsonField = (holder, key) => {
    const v = holder[key];
    if (typeof v !== "string")
      return;
    const r = restoreJsonText(v, map);
    for (const t of r.unresolved)
      unresolved.add(t);
    if (r.text !== v) {
      holder[key] = r.text;
      changed = true;
    }
  };
  switch (protocol) {
    case "openai.chat":
      for (const choice of asArray(body["choices"]).map(asDict)) {
        for (const tc of asArray(asDict(choice?.["message"])?.["tool_calls"]).map(asDict)) {
          const fn = asDict(tc?.["function"]);
          if (fn)
            jsonField(fn, "arguments");
        }
      }
      break;
    case "anthropic.messages":
      for (const block of asArray(body["content"]).map(asDict)) {
        if (!block || block["type"] !== "tool_use" || block["input"] === void 0)
          continue;
        const r = restoreArgs(block["input"], map);
        for (const t of r.unresolved)
          unresolved.add(t);
        if (r.changed) {
          block["input"] = r.args;
          changed = true;
        }
      }
      break;
    case "openai.responses":
      for (const item of asArray(body["output"]).map(asDict)) {
        if (item && item["type"] === "function_call")
          jsonField(item, "arguments");
      }
      break;
  }
  return { body: changed ? JSON.stringify(parsed) : text, changed, unresolved: [...unresolved] };
}

// ../local-redaction/dist/sse.js
var parse = (payload) => {
  try {
    const v = JSON.parse(payload);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};
var dict = (v) => typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
var list = (v) => Array.isArray(v) ? v : [];
var dataFrame = (payload) => `data: ${payload}

`;
var eventFrame = (name, payload) => `event: ${name}
data: ${payload}

`;
function tails() {
  return /* @__PURE__ */ new Map();
}
function tail(m, key) {
  let t = m.get(key);
  if (!t) {
    t = { pending: "", seen: "" };
    m.set(key, t);
  }
  return t;
}
function chatDecoder(r, map, report) {
  const calls = tails();
  let model = "";
  const finish = (t) => {
    const left = tokensIn(t.seen).filter((k) => map.valueOf(k) === void 0);
    if (left.length)
      report(left);
    t.seen = "";
  };
  const flush = () => {
    const byChoice = /* @__PURE__ */ new Map();
    for (const [key, t] of calls) {
      if (t.pending !== "") {
        const [c, i] = key.split(":").map(Number);
        const arr = byChoice.get(c) ?? [];
        arr.push({ index: i, function: { arguments: t.pending } });
        byChoice.set(c, arr);
        t.seen += t.pending;
        t.pending = "";
      }
      finish(t);
    }
    let out = "";
    for (const [c, tool_calls] of byChoice) {
      out += dataFrame(JSON.stringify({
        id: "chatcmpl-ogr-flush",
        object: "chat.completion.chunk",
        ...model ? { model } : {},
        choices: [{ index: c, delta: { tool_calls } }]
      }));
    }
    return out;
  };
  return {
    data(payload, isLast) {
      if (payload === "[DONE]")
        return { before: flush(), payload: null };
      const parsed = parse(payload);
      if (!parsed)
        return { before: "", payload: null };
      if (typeof parsed["model"] === "string" && !model)
        model = parsed["model"];
      const choices = list(parsed["choices"]).map(dict);
      const closing = choices.some((c) => typeof c?.["finish_reason"] === "string");
      let modified = false;
      choices.forEach((choice, ci) => {
        const index = typeof choice?.["index"] === "number" ? choice["index"] : ci;
        list(dict(choice?.["delta"])?.["tool_calls"]).forEach((tc, n) => {
          const call = dict(tc);
          const fn = dict(call?.["function"]);
          if (!call || !fn || typeof fn["arguments"] !== "string")
            return;
          const i = typeof call["index"] === "number" ? call["index"] : n;
          const t = tail(calls, `${index}:${i}`);
          const original = fn["arguments"];
          const restored = r.feed(t, original, isLast || closing);
          t.seen += restored;
          if (restored !== original) {
            fn["arguments"] = restored;
            modified = true;
          }
        });
      });
      const before = closing ? flush() : "";
      return { before, payload: modified ? JSON.stringify(parsed) : null };
    },
    flush
  };
}
function anthropicDecoder(r, map, report) {
  const blocks = tails();
  const kinds = /* @__PURE__ */ new Map();
  const flushBlock = (key) => {
    const t = blocks.get(key);
    if (!t)
      return "";
    let out = "";
    if (t.pending !== "") {
      out = eventFrame("content_block_delta", JSON.stringify({ type: "content_block_delta", index: Number(key), delta: { type: "input_json_delta", partial_json: t.pending } }));
      t.seen += t.pending;
      t.pending = "";
    }
    const left = tokensIn(t.seen).filter((k) => map.valueOf(k) === void 0);
    if (left.length)
      report(left);
    t.seen = "";
    return out;
  };
  const flush = () => {
    let out = "";
    for (const key of blocks.keys())
      out += flushBlock(key);
    return out;
  };
  return {
    data(payload, isLast) {
      const parsed = parse(payload);
      if (!parsed)
        return { before: "", payload: null };
      const key = String(typeof parsed["index"] === "number" ? parsed["index"] : 0);
      switch (parsed["type"]) {
        case "content_block_start": {
          const kind = dict(parsed["content_block"])?.["type"];
          if (typeof kind === "string")
            kinds.set(key, kind);
          return { before: "", payload: null };
        }
        case "content_block_delta": {
          const delta = dict(parsed["delta"]);
          if (!delta || delta["type"] !== "input_json_delta" || typeof delta["partial_json"] !== "string") {
            return { before: "", payload: null };
          }
          const t = tail(blocks, key);
          const original = delta["partial_json"];
          const restored = r.feed(t, original, isLast);
          t.seen += restored;
          if (restored === original)
            return { before: "", payload: null };
          delta["partial_json"] = restored;
          return { before: "", payload: JSON.stringify(parsed) };
        }
        case "content_block_stop":
          return { before: flushBlock(key), payload: null };
        case "message_delta":
        case "message_stop":
          return { before: flush(), payload: null };
        default:
          return { before: "", payload: null };
      }
    },
    flush
  };
}
function responsesDecoder(r, map, report) {
  const items = tails();
  const flushItem = (key) => {
    const t = items.get(key);
    if (!t)
      return "";
    let out = "";
    if (t.pending !== "") {
      out = eventFrame("response.function_call_arguments.delta", JSON.stringify({ type: "response.function_call_arguments.delta", output_index: Number(key), delta: t.pending }));
      t.seen += t.pending;
      t.pending = "";
    }
    t.seen = "";
    return out;
  };
  const flush = () => {
    let out = "";
    for (const key of items.keys())
      out += flushItem(key);
    return out;
  };
  const whole = (holder, field) => {
    if (!holder || typeof holder[field] !== "string")
      return false;
    const res = restoreJsonText(holder[field], map);
    if (res.unresolved.length)
      report(res.unresolved);
    if (res.text === holder[field])
      return false;
    holder[field] = res.text;
    return true;
  };
  return {
    data(payload, isLast) {
      const parsed = parse(payload);
      if (!parsed)
        return { before: "", payload: null };
      const key = String(typeof parsed["output_index"] === "number" ? parsed["output_index"] : 0);
      switch (parsed["type"]) {
        case "response.function_call_arguments.delta": {
          if (typeof parsed["delta"] !== "string")
            return { before: "", payload: null };
          const t = tail(items, key);
          const original = parsed["delta"];
          const restored = r.feed(t, original, isLast);
          t.seen += restored;
          if (restored === original)
            return { before: "", payload: null };
          parsed["delta"] = restored;
          return { before: "", payload: JSON.stringify(parsed) };
        }
        case "response.function_call_arguments.done": {
          const before = flushItem(key);
          return { before, payload: whole(parsed, "arguments") ? JSON.stringify(parsed) : null };
        }
        case "response.output_item.done": {
          const before = flushItem(key);
          const item = dict(parsed["item"]);
          const changed = item?.["type"] === "function_call" && whole(item, "arguments");
          return { before, payload: changed ? JSON.stringify(parsed) : null };
        }
        case "response.completed":
        case "response.incomplete":
        case "response.failed": {
          const before = flush();
          let changed = false;
          for (const item of list(dict(parsed["response"])?.["output"]).map(dict)) {
            if (item?.["type"] === "function_call" && whole(item, "arguments"))
              changed = true;
          }
          return { before, payload: changed ? JSON.stringify(parsed) : null };
        }
        default:
          return { before: "", payload: null };
      }
    },
    flush
  };
}
var FRAME_END = /\r?\n\r?\n/;
function createSseRestorer(protocol, map, opts = {}) {
  const restorer = createStreamRestorer(map, { encode: jsonStringEncode });
  const report = (tokens) => opts.onUnresolved?.(tokens);
  const decoder = protocol === "anthropic.messages" ? anthropicDecoder(restorer, map, report) : protocol === "openai.responses" ? responsesDecoder(restorer, map, report) : chatDecoder(restorer, map, report);
  let carry = "";
  const frame = (text, isLast) => {
    const lines = text.split(/(?<=\n)/);
    let dataAt = -1;
    let count = 0;
    lines.forEach((line2, i) => {
      if (line2.startsWith("data:")) {
        count += 1;
        dataAt = i;
      }
    });
    if (count !== 1)
      return text;
    const line = lines[dataAt];
    const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
    let payload = line.slice(5, line.length - ending.length);
    if (payload.startsWith(" "))
      payload = payload.slice(1);
    const out = decoder.data(payload, isLast);
    if (out.payload !== null)
      lines[dataAt] = `data: ${out.payload}${ending}`;
    return out.before + lines.join("");
  };
  return {
    feed(chunk) {
      carry += chunk;
      let out = "";
      for (; ; ) {
        const m = FRAME_END.exec(carry);
        if (!m)
          break;
        const end = m.index + m[0].length;
        out += frame(carry.slice(0, end), false);
        carry = carry.slice(end);
      }
      return out;
    },
    end() {
      let out = "";
      if (carry !== "") {
        out += frame(carry, true);
        carry = "";
      }
      return out + decoder.flush();
    }
  };
}

// ../local-redaction/dist/redactor.js
var LocalRedactor = class {
  compiled = null;
  maps;
  pending = /* @__PURE__ */ new Map();
  refreshing = null;
  log;
  opts;
  /** The installed HTTP interceptor, when there is one (set by `installHttpInterceptor`). */
  http = null;
  /**
   * Set by an integration whose HOOK-based masking is engaged — the fallback
   * for when model traffic is not passing through the interceptor. It is
   * the other way a step can be provably masked.
   */
  fallbackActive = false;
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log ?? { info: () => {
    }, warn: (m) => console.warn(m) };
    this.maps = new SessionMaps({
      ...opts.bound !== void 0 ? { bound: opts.bound } : {},
      warn: (m) => this.log.warn(m)
    });
  }
  /** Whether a compiled ruleset is in hand. */
  get ready() {
    return this.compiled !== null;
  }
  /** The id reported on every event and heartbeat; `""` until a ruleset arrives. */
  get rulesetId() {
    return this.compiled?.id ?? "";
  }
  get ruleset() {
    return this.compiled;
  }
  /**
   * Whether anything can be shown to be masking the model path: the
   * interceptor has seen traffic, or the hook fallback is engaged. With no
   * interceptor installed the integration decides for itself (true).
   */
  get masking() {
    if (!this.http)
      return true;
    return this.http.sawTraffic || this.fallbackActive;
  }
  cachePath() {
    if (this.opts.cachePath)
      return this.opts.cachePath;
    const src = this.opts.source();
    return src ? defaultCachePath(src.runtimeUrl) : null;
  }
  adopt(ruleset, from) {
    if (this.compiled?.id === ruleset.id)
      return;
    const compiled = compileRuleset(ruleset, {
      ...this.opts.tiers ? { tiers: this.opts.tiers } : {},
      log: (m) => this.log.warn(m)
    });
    this.compiled = compiled;
    this.log.info(`[openguardrails] local redaction: ruleset ${compiled.id} (${from}) \u2014 ${compiled.rules.length} rules` + (compiled.disabled.length ? `, ${compiled.disabled.length} disabled` : "") + (compiled.skipped.length ? `, ${compiled.skipped.length} outside the configured tiers` : ""));
  }
  /**
   * Bring the ruleset up. With a cache: compile it now, refresh in the
   * background, return at once. Without: await ONE fetch (bounded by
   * `timeoutMs`), so the first request of a fresh install is masked.
   */
  async start() {
    const path = this.cachePath();
    const cached = path ? readCachedRuleset(path) : null;
    if (cached) {
      this.adopt(cached, "cache");
      void this.refresh();
      return;
    }
    await this.refresh();
  }
  /** Fetch (with `If-None-Match`) and adopt whatever comes back; coalesces concurrent calls. */
  refresh() {
    if (this.refreshing)
      return this.refreshing;
    this.refreshing = (async () => {
      const src = this.opts.source();
      if (!src)
        return;
      const result = await loadRuleset({
        runtimeUrl: src.runtimeUrl,
        apiKey: src.apiKey,
        ...this.opts.cachePath ? { cachePath: this.opts.cachePath } : {},
        ...this.opts.fetch ? { fetch: this.opts.fetch } : {},
        ...this.opts.timeoutMs !== void 0 ? { timeoutMs: this.opts.timeoutMs } : {}
      });
      if (result.error)
        this.log.warn(`[openguardrails] local redaction: ${result.error}`);
      if (result.ruleset)
        this.adopt(result.ruleset, result.source);
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  /**
   * The heartbeat response carries `rules: {id}`; an id that is not the one
   * held triggers a refetch — how a running plugin learns of a change within
   * one heartbeat interval without polling the feed.
   */
  onHeartbeat(reply) {
    const id = reply?.rules?.id;
    if (typeof id === "string" && id !== "" && id !== this.rulesetId)
      void this.refresh();
  }
  /** Said on every request that goes out unprotected (§4.5) — loud on purpose. */
  warnUnprotected(what) {
    this.log.warn(`[openguardrails] local redaction: no ruleset obtained yet \u2014 ${what} proceeds unmasked`);
  }
  session(sessionId) {
    return this.maps.get(sessionId);
  }
  /**
   * The host's session plus every session the interceptor has masked under:
   * the maps a restore must consult, since a token in a tool call may have
   * been minted at either vantage.
   */
  sessionsFor(sessionId) {
    const keys = [sessionId];
    for (const k of this.http?.sessions() ?? [])
      if (!keys.includes(k))
        keys.push(k);
    return keys;
  }
  record(sessionId, minted) {
    if (minted.length === 0)
      return;
    const list2 = this.pending.get(sessionId) ?? [];
    list2.push(...minted);
    this.pending.set(sessionId, list2);
  }
  /** Mask one text for the session; minted tokens are recorded for the next report. */
  mask(sessionId, text) {
    const r = mask(text, this.session(sessionId), this.compiled);
    this.record(sessionId, r.minted);
    return r;
  }
  /** Mask every string leaf of a value (a request, a message, a tool result). */
  maskValue(sessionId, value) {
    const r = maskLeaves(value, this.session(sessionId), this.compiled);
    this.record(sessionId, r.minted);
    return r;
  }
  /** Known values only — the egress pass every outbound event takes (D6). */
  maskKnown(sessionId, value) {
    return maskKnown(value, this.session(sessionId));
  }
  restore(sessionId, text) {
    return restore(text, this.session(sessionId));
  }
  /**
   * Restore a tool's arguments against the host's session map AND the
   * interceptor's — the two vantages mint into different maps. Idempotent:
   * a value with no token in it restores to itself.
   */
  restoreArgs(sessionId, args) {
    return restoreArgsAcross(args, this.sessionsFor(sessionId).map((k) => this.session(k)));
  }
  /**
   * The `redaction` field for the next event of this session — drains the
   * minted lists of the host session and of every interceptor session.
   * `undefined` when an interceptor is installed and NOTHING has been shown
   * to mask (no traffic seen, no fallback engaged): the event then carries
   * no `redaction` field, so the runtime never reads the step as protected.
   */
  report(sessionId) {
    if (!this.masking)
      return void 0;
    const masked = [];
    for (const key of this.sessionsFor(sessionId)) {
      const list2 = this.pending.get(key);
      if (!list2)
        continue;
      masked.push(...list2);
      this.pending.delete(key);
    }
    return { ruleset: this.rulesetId, masked };
  }
};

// src/daemon.ts
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
var DEFAULT_PORT = 8787;
var port = () => {
  const raw = process.env["OGR_LOCAL_PORT"];
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
};
var stateDir = () => join2(homedir2(), ".openguardrails");
async function probe(p = port(), timeoutMs = 500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${p}/__ogr/status`, { signal: controller.signal });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.ok === true ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function ensure(opts = {}) {
  const p = opts.port ?? port();
  if (await probe(p)) return `http://127.0.0.1:${p}`;
  await mkdir(stateDir(), { recursive: true }).catch(() => {
  });
  const logPath = opts.logPath ?? join2(stateDir(), "ogr-local.log");
  let out = "ignore";
  try {
    out = openSync(logPath, "a");
  } catch {
  }
  const entry = process.env["OGR_LOCAL_ENTRY"] || fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [entry, "serve", "--port", String(p), ...opts.args ?? []], {
    detached: true,
    // ⚠️ stdin must be `ignore`, not inherited: a detached child holding the
    // harness's stdin steals the user's keystrokes on some terminals.
    stdio: ["ignore", out, out],
    env: process.env
  });
  child.unref();
  const deadline = Date.now() + (opts.waitMs ?? 8e3);
  for (; ; ) {
    if (await probe(p, 300)) return `http://127.0.0.1:${p}`;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 60));
  }
}
function baseUrlFor(upstream, p = port()) {
  const u = new URL(upstream);
  const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
  return `http://127.0.0.1:${p}/${u.protocol.replace(":", "")}/${u.host}${path}`;
}

// src/server.ts
import { createServer } from "node:http";
import { Readable } from "node:stream";

// src/pipe.ts
var DEFAULT_SESSION = "process";
var Pipe = class {
  constructor(opts) {
    this.opts = opts;
  }
  counters = { requests: 0, streams: 0, restored: 0, passed: 0, minted: 0 };
  sessions = /* @__PURE__ */ new Set();
  get redactor() {
    return this.opts.redactor;
  }
  /**
   * Mask one outbound request, or answer `null` for "this is not a model
   * call — forward it untouched".
   *
   * ⚠️ A body that does not parse as JSON, or does not sniff as one of the
   * three protocols, is passed through VERBATIM. That is not laziness: the
   * harness talks to its provider about more than completions (token counts,
   * model lists, file uploads), and a proxy that rewrote those would break
   * the harness while protecting nothing.
   */
  mask(url, headers, text) {
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return null;
    }
    const protocol = sniffProtocol(body, url);
    if (!protocol) return null;
    const session = this.opts.sessionKey ? this.opts.sessionKey({ url, body, headers }) : stampedSession(body) ?? DEFAULT_SESSION;
    this.sessions.add(session);
    const masked = this.redactor.maskValue(session, body);
    this.counters.requests += 1;
    this.counters.minted += masked.minted.length;
    return {
      protocol,
      session,
      body: masked.changed ? JSON.stringify(masked.value) : text,
      changed: masked.changed,
      minted: masked.minted.length
    };
  }
  /** Put the values back into a buffered reply's tool-call arguments. */
  restore(plan, text) {
    const r = restoreResponseBody(plan.protocol, text, this.redactor.session(plan.session));
    if (!r) return text;
    if (r.changed) this.counters.restored += 1;
    if (r.unresolved.length) {
      this.opts.log?.warn(
        `[ogr-local] ${r.unresolved.length} placeholder(s) in a tool call had no value to restore \u2014 the model invented or altered a token`
      );
    }
    return r.body;
  }
  /** The same, frame by frame, for an SSE reply. */
  streamRestorer(plan) {
    this.counters.streams += 1;
    let counted = false;
    const inner = createSseRestorer(plan.protocol, this.redactor.session(plan.session), {
      onUnresolved: (tokens) => this.opts.log?.warn(`[ogr-local] ${tokens.length} placeholder(s) in a streamed tool call had no value to restore`)
    });
    return {
      feed: (chunk) => {
        const out = inner.feed(chunk);
        if (!counted && out !== chunk) {
          counted = true;
          this.counters.restored += 1;
        }
        return out;
      },
      end: () => inner.end()
    };
  }
  /**
   * The report for a step, drained across every session this proxy has
   * masked under — the harness's hook cannot know which key its own step
   * was filed under, because the key came off the request body the hook
   * never saw.
   */
  report(session) {
    if (!this.redactor.masking) return void 0;
    const keys = session ? [session] : [...this.sessions];
    if (keys.length === 0) return { ruleset: this.redactor.rulesetId, masked: [] };
    const masked = [];
    let ruleset = this.redactor.rulesetId;
    for (const key of keys) {
      const part = this.redactor.report(key);
      if (!part) continue;
      ruleset = part.ruleset;
      masked.push(...part.masked);
    }
    return { ruleset, masked };
  }
  knownSessions() {
    return [...this.sessions];
  }
};

// src/server.ts
var HOP_BY_HOP = /* @__PURE__ */ new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length"
]);
var DROP_UPSTREAM = /* @__PURE__ */ new Set([...HOP_BY_HOP, "accept-encoding"]);
var nowMs = () => Date.now();
var trimSlash = (u) => u.endsWith("/") ? u.slice(0, -1) : u;
function upstreamFor(url, fallback) {
  const m = /^\/(https?)\/([^/]+)(\/.*)?$/.exec(url.pathname);
  if (m) {
    const [, scheme, host, rest] = m;
    return {
      base: `${scheme}://${host}`,
      path: rest ?? "/",
      host,
      hostname: new URL(`${scheme}://${host}`).hostname
    };
  }
  if (!fallback) return null;
  const u = new URL(fallback);
  return { base: fallback, path: url.pathname, host: u.host, hostname: u.hostname };
}
async function startProxy(opts) {
  const log2 = opts.log ?? { info: (m) => console.error(m), warn: (m) => console.error(m) };
  const pipe = new Pipe({ ...opts, log: log2 });
  const fallback = opts.upstream ? trimSlash(opts.upstream) : null;
  let lastActivity = nowMs();
  const server = createServer((req, res) => {
    lastActivity = nowMs();
    req.on("error", () => {
    });
    res.on("error", () => {
    });
    handle(req, res).catch((err) => {
      log2.warn(`[ogr-local] ${String(err)}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "ogr_local_proxy_failed", detail: String(err) }));
    });
  });
  async function readBody(req) {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    return Buffer.concat(parts);
  }
  async function handle(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname.startsWith("/__ogr/")) return control(req, res, url);
    const raw = await readBody(req);
    const route = upstreamFor(url, fallback);
    if (!route) {
      return refuse(res, 404, "ogr_local_no_upstream", "no upstream in the path and none configured \u2014 see the README's base-URL wiring");
    }
    if (!isModelHost(route.hostname, opts.hosts)) {
      return refuse(res, 403, "ogr_local_upstream_refused", `${route.hostname} is not a known model API host (add it with --host)`);
    }
    const target = new URL(route.base + route.path + url.search);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === void 0 || DROP_UPSTREAM.has(k.toLowerCase())) continue;
      headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    }
    let plan = null;
    let out = raw.length > 0 ? raw : void 0;
    if (raw.length > 0) {
      if (!pipe.redactor.ready) {
        if (opts.failClosed && looksLikeModelCall(raw)) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "ogr_local_unprotected", detail: "no secret ruleset in hand and the deployment is fail-closed" }));
          return;
        }
        pipe.redactor.warnUnprotected("this model request");
      }
      plan = pipe.mask(target, headers, raw.toString("utf8"));
      if (plan) out = Buffer.from(plan.body, "utf8");
      else pipe.counters.passed += 1;
    }
    if (out) headers.set("content-length", String(out.byteLength));
    const upstreamRes = await fetch(target, {
      method: req.method ?? "GET",
      headers,
      ...out ? { body: out } : {},
      redirect: "manual"
    });
    const replyHeaders = {};
    upstreamRes.headers.forEach((v, k) => {
      if (!HOP_BY_HOP.has(k.toLowerCase())) replyHeaders[k] = v;
    });
    delete replyHeaders["content-encoding"];
    const type = upstreamRes.headers.get("content-type") ?? "";
    if (!plan || !upstreamRes.body) {
      delete replyHeaders["content-length"];
      res.writeHead(upstreamRes.status, replyHeaders);
      if (upstreamRes.body) await pump(upstreamRes.body, res);
      else res.end();
      return;
    }
    if (type.includes("text/event-stream")) {
      delete replyHeaders["content-length"];
      res.writeHead(upstreamRes.status, replyHeaders);
      const restorer = pipe.streamRestorer(plan);
      const decoder = new TextDecoder();
      for await (const chunk of upstreamRes.body) {
        res.write(restorer.feed(decoder.decode(chunk, { stream: true })));
      }
      const tail2 = restorer.end();
      if (tail2) res.write(tail2);
      res.end();
      return;
    }
    const text = await upstreamRes.text();
    const restored = pipe.restore(plan, text);
    const bytes = Buffer.from(restored, "utf8");
    replyHeaders["content-length"] = String(bytes.byteLength);
    res.writeHead(upstreamRes.status, replyHeaders);
    res.end(bytes);
  }
  function refuse(res, status, error, detail) {
    const bytes = Buffer.from(JSON.stringify({ error, detail }), "utf8");
    res.writeHead(status, { "content-type": "application/json", "content-length": String(bytes.byteLength) });
    res.end(bytes);
  }
  function looksLikeModelCall(raw) {
    try {
      const b = JSON.parse(raw.toString("utf8"));
      return b["messages"] !== void 0 || b["input"] !== void 0 || b["instructions"] !== void 0;
    } catch {
      return false;
    }
  }
  async function pump(body, res) {
    await new Promise((resolve, reject) => {
      Readable.fromWeb(body).on("error", reject).on("end", resolve).pipe(res);
    });
  }
  async function control(req, res, url) {
    const reply = (status, payload) => {
      const bytes = Buffer.from(JSON.stringify(payload), "utf8");
      res.writeHead(status, { "content-type": "application/json", "content-length": String(bytes.byteLength) });
      res.end(bytes);
    };
    if (url.pathname === "/__ogr/status") {
      return reply(200, {
        ok: true,
        served_by: opts.servedBy ?? "",
        upstream: fallback,
        ruleset: pipe.redactor.rulesetId,
        masking: pipe.redactor.masking && pipe.redactor.ready,
        sessions: pipe.knownSessions().length,
        counters: pipe.counters
      });
    }
    if (url.pathname === "/__ogr/mask" && req.method === "POST") {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString("utf8") || "{}");
      } catch {
        return reply(400, { error: "bad_json" });
      }
      const session = body.session ?? pipe.knownSessions()[0] ?? "process";
      const masked = pipe.redactor.maskKnown(session, body.value ?? null);
      return reply(200, {
        value: masked.value,
        changed: masked.changed,
        ...pipe.report(session) ? { redaction: pipe.report(session) } : {}
      });
    }
    return reply(404, { error: "not_found" });
  }
  await new Promise((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const address = server.address();
  const port2 = typeof address === "object" && address ? address.port : 0;
  let idleTimer;
  if (opts.idleMs && opts.idleMs > 0) {
    idleTimer = setInterval(() => {
      if (nowMs() - lastActivity > opts.idleMs) {
        log2.info("[ogr-local] idle \u2014 shutting down");
        void close();
      }
    }, Math.min(opts.idleMs, 3e4));
    idleTimer.unref?.();
  }
  const close = async () => {
    if (idleTimer) clearInterval(idleTimer);
    await new Promise((resolve) => server.close(() => resolve()));
  };
  return { url: `http://127.0.0.1:${port2}`, port: port2, pipe, close };
}

// src/cli.ts
var log = { info: (m) => console.error(m), warn: (m) => console.error(m) };
async function serve(argv, flag, has) {
  const runtimeUrl = flag("runtime") ?? process.env["OGR_RUNTIME_URL"] ?? "https://openguardrails.com";
  const apiKey = flag("api-key") ?? process.env["OGR_API_KEY"] ?? "";
  if (!apiKey) {
    console.error("[ogr-local] no OGR_API_KEY \u2014 refusing to start a proxy that could not mask anything");
    process.exit(1);
  }
  const redactor = new LocalRedactor({
    source: () => ({ runtimeUrl, apiKey }),
    ...process.env["OGR_RULES_CACHE"] ? { cachePath: process.env["OGR_RULES_CACHE"] } : {},
    log
  });
  await redactor.start();
  redactor.fallbackActive = true;
  const idleMs = Number(flag("idle-ms") ?? process.env["OGR_LOCAL_IDLE_MS"] ?? 6 * 60 * 60 * 1e3);
  const proxy = await startProxy({
    redactor,
    ...flag("upstream") ? { upstream: flag("upstream") } : {},
    ...flag("host") ? { hosts: flag("host").split(",").map((h) => h.trim()).filter(Boolean) } : {},
    ...flag("served-by") ? { servedBy: flag("served-by") } : {},
    port: Number(flag("port") ?? port()),
    failClosed: has("fail-closed") || process.env["OGR_FAIL_MODE"] === "closed",
    idleMs: Number.isFinite(idleMs) ? idleMs : 0,
    log
  });
  log.info(
    `[ogr-local] listening on ${proxy.url} \u2014 ruleset ${redactor.rulesetId || "(none)"}` + (flag("served-by") ? ` \u2014 served by ${flag("served-by")}` : "")
  );
  const timer = setInterval(() => void redactor.refresh(), 6e4);
  timer.unref?.();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => void proxy.close().then(() => process.exit(0)));
  }
}
async function main(argv = process.argv.slice(2)) {
  const flag = (name) => {
    const at = argv.indexOf(`--${name}`);
    return at !== -1 ? argv[at + 1] : void 0;
  };
  const has = (name) => argv.includes(`--${name}`);
  switch (argv[0]) {
    case "serve":
      return serve(argv, flag, has);
    case "ensure": {
      const url = await ensure({
        ...flag("port") ? { port: Number(flag("port")) } : {},
        args: [
          ...flag("upstream") ? ["--upstream", flag("upstream")] : [],
          ...flag("host") ? ["--host", flag("host")] : [],
          ...has("fail-closed") ? ["--fail-closed"] : []
        ]
      });
      if (url) console.log(url);
      else console.error("[ogr-local] could not start a masking proxy \u2014 the harness will run unprotected");
      return;
    }
    case "status": {
      const s = await probe(flag("port") ? Number(flag("port")) : void 0);
      console.log(JSON.stringify(s ?? { ok: false }, null, 2));
      return;
    }
    case "base-url": {
      const upstream = argv[1];
      if (!upstream) {
        console.error("usage: ogr-local base-url <https://api.example.com[/prefix]>");
        process.exit(2);
      }
      console.log(baseUrlFor(upstream, flag("port") ? Number(flag("port")) : void 0));
      return;
    }
    default:
      console.error(
        "usage: ogr-local <ensure|serve|status|base-url> [--port N] [--upstream URL] [--host a,b] [--served-by NAME] [--fail-closed]"
      );
      process.exit(2);
  }
}

// src/bundle.ts
function invokedAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}
if (invokedAsScript()) {
  void main().catch((err) => {
    console.error(`[ogr-local] ${String(err)}`);
    process.exit(1);
  });
}
export {
  DEFAULT_PORT,
  DEFAULT_SESSION,
  Pipe,
  baseUrlFor,
  ensure,
  main,
  port,
  probe,
  startProxy,
  stateDir,
  upstreamFor
};
