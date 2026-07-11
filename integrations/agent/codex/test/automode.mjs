// Auto-mode hook tests: run the built PermissionRequest hook against a mock
// OGR runtime, assert decisions, fail-closed semantics, transcript projection,
// and the denial-escalation backstop.
// Run: npm run build && npm test
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "ogr-codex-automode-hook.mjs",
)

// --- mock OGR runtime ---------------------------------------------------------

let decideHandler = () => ({ status: 200, body: { decision: "allow" } })
let enrollHandler = () => ({
  status: 200,
  body: { agent_id: "codex-test", credential: "cred-1" },
})
const requests = []

const server = createServer((req, res) => {
  let raw = ""
  req.on("data", (chunk) => (raw += chunk))
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {}
    requests.push({ path: req.url, body, auth: req.headers.authorization ?? "" })
    const handler = req.url === "/api/v1/enroll" ? enrollHandler : decideHandler
    const { status, body: out } = handler(body)
    res.writeHead(status, { "content-type": "application/json" })
    res.end(JSON.stringify(out))
  })
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const SERVER = `http://127.0.0.1:${server.address().port}`

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
        OGR_SERVER: SERVER,
        OGR_ENROLL_TOKEN: "et-test",
        OGR_STATE_DIR: stateDir,
        OGR_TIMEOUT_MS: "2000",
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

test("runtime allow → behavior allow", async () => {
  decideHandler = () => ({ status: 200, body: { decision: "allow" } })
  eq((await runHook(payload("ls"), { stateDir: freshStateDir() })).kind, "allow")
})

test("runtime block → behavior deny with reason", async () => {
  decideHandler = () => ({
    status: 200,
    body: { decision: "block", reasons: ["reads credentials"] },
  })
  const result = await runHook(payload("cat ~/.ssh/id_rsa"), { stateDir: freshStateDir() })
  eq(result.kind, "deny")
  if (!result.message.includes("reads credentials")) {
    throw new Error(`reason missing from message: ${result.message}`)
  }
})

test("require_approval → abstain (codex's own prompt)", async () => {
  decideHandler = () => ({
    status: 200,
    body: { decision: "require_approval", approval_id: "apr-1" },
  })
  eq((await runHook(payload("kubectl apply -f prod.yaml"), { stateDir: freshStateDir() })).kind, "abstain")
})

test("runtime 500 → abstain (fail closed to ask)", async () => {
  decideHandler = () => ({ status: 500, body: {} })
  eq((await runHook(payload("ls"), { stateDir: freshStateDir() })).kind, "abstain")
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

test("missing enroll token → abstain", async () => {
  eq(
    (await runHook(payload("ls"), { stateDir: freshStateDir(), env: { OGR_ENROLL_TOKEN: "" } })).kind,
    "abstain",
  )
})

test("enrollment is cached across invocations, stale credential re-enrolls", async () => {
  const stateDir = freshStateDir()
  decideHandler = () => ({ status: 200, body: { decision: "allow" } })
  requests.length = 0
  await runHook(payload("ls"), { stateDir })
  await runHook(payload("ls"), { stateDir })
  const enrolls = requests.filter((r) => r.path === "/api/v1/enroll")
  eq(enrolls.length, 1)

  // Now the credential goes stale: first decide 401s, hook re-enrolls once.
  requests.length = 0
  let first = true
  enrollHandler = () => ({ status: 200, body: { agent_id: "codex-test", credential: "cred-2" } })
  decideHandler = () => {
    if (first) {
      first = false
      return { status: 401, body: {} }
    }
    return { status: 200, body: { decision: "allow" } }
  }
  // The mock can't inspect auth per-call order here, so assert via traffic shape.
  eq((await runHook(payload("ls"), { stateDir })).kind, "allow")
  eq(requests.filter((r) => r.path === "/api/v1/enroll").length, 1)
  eq(requests.filter((r) => r.path === "/api/v1/decide").length, 2)
  enrollHandler = () => ({ status: 200, body: { agent_id: "codex-test", credential: "cred-1" } })
})

test("denial escalation: 3rd consecutive deny abstains to the human", async () => {
  const stateDir = freshStateDir()
  decideHandler = () => ({ status: 200, body: { decision: "block", reasons: ["nope"] } })
  eq((await runHook(payload("x1"), { stateDir })).kind, "deny")
  eq((await runHook(payload("x2"), { stateDir })).kind, "deny")
  eq((await runHook(payload("x3"), { stateDir })).kind, "abstain")
  // ...and stays deferred for the rest of the turn.
  eq((await runHook(payload("x4"), { stateDir })).kind, "abstain")
  // A new turn resets the counters.
  eq((await runHook(payload("x5", { turn_id: "turn-2" }), { stateDir })).kind, "deny")
})

test("allow resets the consecutive denial counter", async () => {
  const stateDir = freshStateDir()
  decideHandler = () => ({ status: 200, body: { decision: "block" } })
  eq((await runHook(payload("x1"), { stateDir })).kind, "deny")
  eq((await runHook(payload("x2"), { stateDir })).kind, "deny")
  decideHandler = () => ({ status: 200, body: { decision: "allow" } })
  eq((await runHook(payload("ok"), { stateDir })).kind, "allow")
  decideHandler = () => ({ status: 200, body: { decision: "block" } })
  eq((await runHook(payload("x3"), { stateDir })).kind, "deny")
})

test("transcript is reasoning-blind and rides in the GuardEvent payload", async () => {
  const stateDir = freshStateDir()
  const rollout = join(stateDir, "rollout.jsonl")
  const lines = [
    { timestamp: "t", type: "session_meta", payload: {} },
    {
      timestamp: "t",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "clean the build dir" }],
      },
    },
    {
      timestamp: "t",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Sure, totally safe, trust me!" }],
      },
    },
    {
      timestamp: "t",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: '{"cmd":"rm -rf build"}',
        call_id: "c1",
      },
    },
    {
      timestamp: "t",
      type: "response_item",
      payload: { type: "function_call_output", call_id: "c1", output: "SECRET OUTPUT" },
    },
  ]
  writeFileSync(rollout, lines.map((l) => JSON.stringify(l)).join("\n"))

  decideHandler = () => ({ status: 200, body: { decision: "allow" } })
  requests.length = 0
  await runHook(payload("rm -rf build", { transcript_path: rollout }), { stateDir })
  const decide = requests.find((r) => r.path === "/api/v1/decide")
  eq(decide.body.kind, "tool_call")
  eq(decide.body.observation_point, "agent_hook")
  eq(decide.body.payload.name, "Bash")
  eq(decide.body.payload.transcript, [
    { role: "user", text: "clean the build dir" },
    { role: "assistant", tool: "exec_command", input: { cmd: "rm -rf build" } },
  ])
  const serialized = JSON.stringify(decide.body)
  if (serialized.includes("trust me") || serialized.includes("SECRET OUTPUT")) {
    throw new Error("assistant prose or tool output leaked into the transcript")
  }
})

test("policy file rides in the GuardEvent payload", async () => {
  const stateDir = freshStateDir()
  const policyPath = join(stateDir, "automode-policy.json")
  writeFileSync(policyPath, JSON.stringify({ soft_deny: ["never push to remote branches"] }))
  decideHandler = () => ({ status: 200, body: { decision: "allow" } })
  requests.length = 0
  await runHook(payload("git status"), { stateDir, env: { OGR_AUTOMODE_POLICY: policyPath } })
  const decide = requests.find((r) => r.path === "/api/v1/decide")
  eq(decide.body.payload.policy, { soft_deny: ["never push to remote branches"] })
})

test("non-PermissionRequest payload → abstain", async () => {
  eq(
    (await runHook(payload("ls", { hook_event_name: "PreToolUse" }), { stateDir: freshStateDir() })).kind,
    "abstain",
  )
})

// --- runner --------------------------------------------------------------------

let fail = 0
const cleanups = []
for (const [name, fn] of cases) {
  try {
    await fn()
    console.log(`✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`✗ ${name}  (${e.message})`)
  }
}
server.close()
for (const dir of cleanups) rmSync(dir, { recursive: true, force: true })
console.log(fail ? `\n${fail} FAILED` : "\nall passed")
process.exit(fail ? 1 : 0)
