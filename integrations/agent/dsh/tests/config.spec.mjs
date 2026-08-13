/** Guardrails resolution: default → workspace file → cordis config. */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DEFAULT_POLICY, DEFAULT_TAINT_TOOL_PATTERN, loadGuardrailsConfig } from "../dist/index.js"

/** A temp workspace, optionally seeded with a policy at `relative`. */
function workspace(policy, relative = join(".dsh", "guardrails.json")) {
  const dir = mkdtempSync(join(tmpdir(), "ogr-dsh-cfg-"))
  if (policy !== undefined) {
    const path = join(dir, relative)
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, typeof policy === "string" ? policy : JSON.stringify(policy))
  }
  return dir
}

test("no workspace and no config resolves to the default policy", () => {
  const resolved = loadGuardrailsConfig(undefined, undefined)
  assert.deepEqual(resolved.policy, DEFAULT_POLICY)
  assert.equal(resolved.judge, undefined)
  assert.equal(resolved.guardToolResults, true)
  assert.equal(resolved.failClosed, false)
  assert.deepEqual(resolved.taint, { toolResults: true, toolResultPattern: DEFAULT_TAINT_TOOL_PATTERN })
})

test("a workspace policy file wins over the default", () => {
  const mine = { composition: { default: { strategy: "deny-wins" } }, config_rules: {} }
  const resolved = loadGuardrailsConfig(workspace(mine), {})
  assert.deepEqual(resolved.policy, mine)
})

test("an inline policy wins over the workspace file", () => {
  const inline = { composition: {}, config_rules: { command_rules: [] } }
  const resolved = loadGuardrailsConfig(workspace({ config_rules: { egress_allowlist: ["a"] } }), { policy: inline })
  assert.deepEqual(resolved.policy, inline)
})

test("a relative policyPath resolves against the workspace", () => {
  const mine = { config_rules: { egress_allowlist: ["example.com"] } }
  const dir = workspace(mine, join("guards", "ogr.json"))
  const resolved = loadGuardrailsConfig(dir, { policyPath: join("guards", "ogr.json") })
  assert.deepEqual(resolved.policy, mine)
})

test("a malformed policy file keeps the default and reports why", () => {
  const warnings = []
  const resolved = loadGuardrailsConfig(workspace("{ not json"), {}, (m) => warnings.push(m))
  assert.deepEqual(resolved.policy, DEFAULT_POLICY)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /could not parse guardrails policy/)
})

test("a missing policy file is not an error", () => {
  const warnings = []
  const resolved = loadGuardrailsConfig(workspace(undefined), {}, (m) => warnings.push(m))
  assert.deepEqual(resolved.policy, DEFAULT_POLICY)
  assert.deepEqual(warnings, [])
})

test("a policy file may carry the judge", () => {
  const judge = { baseURL: "https://api.example/v1", model: "guard-1" }
  const resolved = loadGuardrailsConfig(workspace({ config_rules: {}, judge }), {})
  assert.deepEqual(resolved.judge, judge)
})

test("the cordis config's judge wins over the policy file's", () => {
  const fromConfig = { baseURL: "https://config.example/v1", model: "from-config" }
  const resolved = loadGuardrailsConfig(
    workspace({ config_rules: {}, judge: { baseURL: "https://file.example/v1", model: "from-file" } }),
    { judge: fromConfig },
  )
  assert.deepEqual(resolved.judge, fromConfig)
})

test("a half-written judge is ignored with a warning, never used", () => {
  const warnings = []
  const resolved = loadGuardrailsConfig(undefined, { judge: { baseURL: "https://api.example/v1" } }, (m) => warnings.push(m))
  assert.equal(resolved.judge, undefined)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /needs both `baseURL` and `model`/)
})

test("an empty judge block is not a misconfiguration", () => {
  const warnings = []
  // What config validation materializes when the operator wrote no judge at all.
  const resolved = loadGuardrailsConfig(undefined, { judge: { headers: {} } }, (m) => warnings.push(m))
  assert.equal(resolved.judge, undefined)
  assert.deepEqual(warnings, [])
})

test("the taint axis is configurable and defaults are filled in", () => {
  const resolved = loadGuardrailsConfig(undefined, { taint: { toolResultPattern: "^scrape_" } })
  assert.equal(resolved.taint.toolResults, true)
  assert.equal(resolved.taint.toolResultPattern, "^scrape_")
})
