import assert from "node:assert/strict";
import { test } from "node:test";
import { decideTool } from "../src/decide.js";

const v = (name: string, args: Record<string, unknown>, workspaces: string[] = ["/work"]) => decideTool({ name, args }, { workspaces }).verdict;

test("the three harnesses' shell tools all reach the gate", () => {
  for (const name of ["terminal", "exec", "bash"]) {
    assert.equal(v(name, { command: "ls" }), "allow", name);
    assert.equal(v(name, { command: "rm -rf /" }), "deny", name);
    assert.equal(v(name, { command: "curl https://x.dev" }), "judge", name);
  }
  assert.equal(v("exec", { command: ["ls", "-la"] }), "allow");
  assert.equal(v("bash", {}), "judge");
});

test("reads", () => {
  assert.equal(v("read_file", { path: "src/a.ts" }), "allow");
  assert.equal(v("read", { file_path: "/work/a.ts" }), "allow");
  assert.equal(v("read", { path: "/etc/passwd" }), "judge");
  assert.equal(v("read", { path: "../other/a.ts" }), "judge");
  assert.equal(v("read", { path: "~/notes.md" }), "judge");
  assert.equal(v("read", { path: ".env" }), "judge");
  assert.equal(v("read", { path: "/home/a/.ssh/id_rsa" }), "deny");
  assert.equal(v("read", {}), "judge");
  assert.equal(v("grep", { pattern: "x" }), "allow");
  assert.equal(v("search_files", { pattern: "x", path: "/etc" }), "judge");
});

test("writes", () => {
  assert.equal(v("write_file", { path: "src/a.ts", content: "" }), "allow");
  assert.equal(v("edit", { path: "/work/src/a.ts" }), "allow");
  assert.equal(v("patch", { path: "/elsewhere/a.ts" }), "judge");
  assert.equal(v("write", { path: "/work/../etc/x" }), "judge");
});

test("a write inside the workspace that runs later or changes the rules goes to the model", () => {
  for (const path of [".git/hooks/pre-commit", ".github/workflows/ci.yml", "package.json", "Makefile", ".claude/settings.json", ".bashrc", "sub/.husky/pre-push", "AGENTS.md"]) {
    assert.equal(v("write_file", { path }), "judge", path);
  }
  assert.equal(v("write_file", { path: "docs/package.json.md" }), "allow");
});

test("nobody can rewrite the guard", () => {
  assert.equal(v("write_file", { path: "/home/a/.openguardrails/config.json" }), "deny");
  assert.equal(v("read", { path: "/home/a/.openguardrails/config.json" }), "judge");
  assert.equal(v("bash", { command: "rm ~/.openguardrails/config.json" }), "judge");
});

test("a tool the rules do not know is never allowed", () => {
  for (const name of ["execute_code", "delegate_task", "web_fetch", "browser", "message", "send_message", "memory", "apply_patch", "cronjob", "sessions_send", "brand_new_tool"]) {
    assert.equal(v(name, {}), "judge", name);
  }
  assert.equal(v("constructor", {}), "judge");
});

test("the agent's own bookkeeping needs no judgement", () => {
  for (const name of ["todo", "todo_write", "skills_list", "get_goal"]) assert.equal(v(name, {}), "allow", name);
});
