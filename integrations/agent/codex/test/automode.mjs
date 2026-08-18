// Auto-mode (PermissionRequest) hook tests against the strict v0.8 mock
// runtime: allow/deny mapping, abstain-to-human on every no-verdict path,
// the denial-escalation backstop, unjudged/span deferral, rollout mapping,
// and exact wire conformance.
// Run: npm test  (no build step — the hook is its own source)
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { API_KEY, allowVerdict, startMockRuntime } from "./mock-runtime.mjs"

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "ogr-codex-automode-hook.mjs",
)
const mock = await startMockRuntime()

// --- helpers -------------------------------------------------------------------

function freshStateDir() {
  return mkdtempSync(join(tmpdir(), "ogr-automode-test-"))
}

// Async so the in-process mock server keeps serving while the hook runs.
function runHook(payload, { stateDir, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [HOOK], {
      env: {
        ...process.env,
        // The default runs exercise the LEGACY aliases (OGR_SERVER /
        // OGR_ENROLL_TOKEN) so alias support stays covered; the canonical
        // vars are blanked so the outer environment can't leak in.
        OGR_RUNTIME_URL: "",
        OGR_API_KEY: "",
        OGR_SERVER: mock.url,
        OGR_ENROLL_TOKEN: API_KEY,
        OGR_STATE_DIR: stateDir,
        OGR_TIMEOUT_MS: "2000",
        OGR_AGENT_ID: "",
        OGR_AGENT_TYPE: "",
        OGR_AGENT_WORKSPACE: "",
        OGR_AGENT_USER: "",
        ...env,
      },
    })
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    child.on("error", reject)
    child.on("close", () => {
      out = out.trim()
      if (!out) return resolve({ kind: "abstain" })
      try {
        const decision = JSON.parse(out).hookSpecificOutput.decision
        resolve({ kind: decision.behavior, message: decision.message })
      } catch (e) {
        reject(new Error(`bad hook stdout: ${out} (${e.message})`))
      }
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

function payload(command, extra = {}) {
  return {
    hook_event_name: "PermissionRequest",
    session_id: "sess-1",
    turn_id: "turn-1",
    cwd: "/w",
    model: "gpt-5",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command },
    transcript_path: null,
    ...extra,
  }
}

const cases = []
const test = (name, fn) => cases.push([name, fn])
const eq = (got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  }
}

// --- cases ---------------------------------------------------------------------

test("runtime allow → behavior allow; wire is one canonical step/response", async () => {
  mock.verdictHandler = allowVerdict()
  mock.requests.length = 0
  eq((await runHook(payload("ls"), { stateDir: freshStateDir() })).kind, "allow")
  eq(mock.requests.length, 1)
  const ev = mock.requests[0].body
  eq(ev.kind, "step/response")
  eq(ev.llm_protocol, "canonical")
  eq(ev.agent_id, "")
  eq(ev.agent_type, "codex")
  eq(ev.agent_workspace, "")
  eq(ev.agent_user, "")
  eq(ev.payload.tool_calls.length, 1)
  eq(ev.payload.tool_calls[0].name, "Bash")
  eq(ev.payload.tool_calls[0].arguments, { command: "ls" })
  eq(ev.payload.model, "gpt-5")
})

test("runtime block → behavior deny with the finding's category and subject", async () => {
  mock.verdictHandler = () => ({
    status: 200,
    body: {
      event_id: "evt_2", provider: "mock-runtime", decision: "block",
      findings: [{
        category: "security.secret.credential_read", severity: "high", action: "block",
        path: "payload.tool_calls.0.arguments.command",
        subject: "cat ~/.ssh/${OGR_PATH_1}", detector: "tool-judge",
      }],
    },
  })
  const result = await runHook(payload("cat ~/.ssh/id_rsa"), { stateDir: freshStateDir() })
  eq(result.kind, "deny")
  if (!result.message.includes("security.secret.credential_read") || !result.message.includes("${OGR_PATH_1}")) {
    throw new Error(`finding detail missing from message: ${result.message}`)
  }
})

test("runtime 500 → abstain (the human decides)", async () => {
  mock.verdictHandler = () => ({ status: 500, body: {} })
  eq((await runHook(payload("ls"), { stateDir: freshStateDir() })).kind, "abstain")
  mock.verdictHandler = allowVerdict()
})

test("runtime unreachable → abstain", async () => {
  eq(
    (await runHook(payload("ls"), {
      stateDir: freshStateDir(),
      env: { OGR_SERVER: "http://127.0.0.1:1" },
    })).kind,
    "abstain",
  )
})

test("missing API key (and legacy token) → abstain", async () => {
  mock.requests.length = 0
  eq(
    (
      await runHook(payload("ls"), {
        stateDir: freshStateDir(),
        env: { OGR_ENROLL_TOKEN: "", OGR_API_KEY: "" },
      })
    ).kind,
    "abstain",
  )
  eq(mock.requests.length, 0)
})

test("canonical OGR_RUNTIME_URL/OGR_API_KEY take precedence over legacy aliases", async () => {
  mock.verdictHandler = allowVerdict()
  eq(
    (
      await runHook(payload("ls"), {
        stateDir: freshStateDir(),
        // Legacy vars point nowhere; the canonical pair must win.
        env: { OGR_RUNTIME_URL: mock.url, OGR_API_KEY: API_KEY, OGR_SERVER: "http://127.0.0.1:1" },
      })
    ).kind,
    "allow",
  )
})

test("allow with unjudged held call → abstain (never auto-approve 'could not look')", async () => {
  mock.verdictHandler = allowVerdict({ unjudged: ["payload.tool_calls.0.arguments.command"] })
  eq((await runHook(payload("ls"), { stateDir: freshStateDir() })).kind, "abstain")
  mock.verdictHandler = allowVerdict()
})

test("allow with spans on the held call → abstain (hook cannot redact a pending call)", async () => {
  mock.verdictHandler = allowVerdict({
    modifications: { spans: [{ path: "payload.tool_calls.0.arguments.command", start: 0, end: 5, replacement: "${OGR_EMAIL_1}" }] },
  })
  eq((await runHook(payload("mail x@y.z"), { stateDir: freshStateDir() })).kind, "abstain")
  mock.verdictHandler = allowVerdict()
})

test("denial escalation: 3rd consecutive deny abstains to the human", async () => {
  const stateDir = freshStateDir()
  mock.verdictHandler = () => ({
    status: 200,
    body: { event_id: "evt_3", provider: "mock-runtime", decision: "block" },
  })
  eq((await runHook(payload("x1"), { stateDir })).kind, "deny")
  eq((await runHook(payload("x2"), { stateDir })).kind, "deny")
  eq((await runHook(payload("x3"), { stateDir })).kind, "abstain")
  // ...and stays deferred for the rest of the turn.
  eq((await runHook(payload("x4"), { stateDir })).kind, "abstain")
  // A new turn resets the counters.
  eq((await runHook(payload("x5", { turn_id: "turn-2" }), { stateDir })).kind, "deny")
  mock.verdictHandler = allowVerdict()
})

test("allow resets the consecutive denial counter", async () => {
  const stateDir = freshStateDir()
  const block = () => ({
    status: 200,
    body: { event_id: "evt_4", provider: "mock-runtime", decision: "block" },
  })
  mock.verdictHandler = block
  eq((await runHook(payload("x1"), { stateDir })).kind, "deny")
  eq((await runHook(payload("x2"), { stateDir })).kind, "deny")
  mock.verdictHandler = allowVerdict()
  eq((await runHook(payload("ok"), { stateDir })).kind, "allow")
  mock.verdictHandler = block
  eq((await runHook(payload("x3"), { stateDir })).kind, "deny")
  mock.verdictHandler = allowVerdict()
})

test("rollout: the current generation rides as text/reasoning on the payload", async () => {
  const stateDir = freshStateDir()
  const rollout = join(stateDir, "rollout.jsonl")
  const lines = [
    { timestamp: "t", type: "session_meta", payload: {} },
    { timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "old ask" }] } },
    { timestamp: "t", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "STALE PROSE" }] } },
    { timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "clean the build dir" }] } },
    { timestamp: "t", type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "build/ is generated" }] } },
    { timestamp: "t", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Removing the build directory." }] } },
  ]
  writeFileSync(rollout, lines.map((l) => JSON.stringify(l)).join("\n"))
  mock.verdictHandler = allowVerdict()
  mock.requests.length = 0
  await runHook(payload("rm -rf build", { transcript_path: rollout }), { stateDir })
  const p = mock.requests[0].body.payload
  eq(p.text, "Removing the build directory.")
  eq(p.reasoning, "build/ is generated")
  if (JSON.stringify(p).includes("STALE PROSE")) throw new Error("previous generation leaked into the payload")
})

test("non-PermissionRequest payload → abstain", async () => {
  eq(
    (await runHook(payload("ls", { hook_event_name: "PreToolUse" }), { stateDir: freshStateDir() })).kind,
    "abstain",
  )
})

// --- runner --------------------------------------------------------------------

let fail = 0
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`✗ ${name}  (${e.message})`)
  }
}
mock.close()
if (mock.violations.length) {
  fail++
  console.log(`✗ wire conformance: ${mock.violations.length} violation(s):\n  - ${mock.violations.join("\n  - ")}`)
} else {
  console.log("✓ wire conformance: every event matched the v0.8 schema exactly")
}
console.log(fail ? `\n${fail} FAILED` : "\nall passed")
process.exit(fail ? 1 : 0)
