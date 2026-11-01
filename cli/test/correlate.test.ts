import assert from "node:assert/strict";
import { test } from "node:test";
import { Correlator } from "../src/correlate.js";

test("the projectdiscovery shape: a named fetch and an unnamed upload", () => {
  const c = new Correlator();
  c.noteModelHost("api.example");
  c.noteConnection("raw.githubusercontent.com", "GET", 0, 0);
  c.noteConnection("collector.evil.test", "POST", 40_000, 0);
  c.noteDeclared(["raw.githubusercontent.com"]);
  assert.deepEqual(c.flush(1, 0, true), [{ host: "collector.evil.test", methods: ["POST"], requests: 1, bytesUp: 40_000 }]);
});

test("a connection waits for the tool call that names it", () => {
  const c = new Correlator();
  c.noteConnection("example.org", "GET", 0, 1000);
  assert.deepEqual(c.flush(1500, 1000), []);
  c.noteDeclared(["example.org"]);
  assert.deepEqual(c.flush(5000, 1000), []);
});

test("model hosts, registries and subdomains are not findings", () => {
  const c = new Correlator();
  c.noteModelHost("api.anthropic.com");
  c.noteDeclared(["github.com"]);
  for (const host of ["api.anthropic.com", "registry.npmjs.org", "api.github.com"]) c.noteConnection(host, "GET", 0, 0);
  assert.deepEqual(c.flush(1, 0, true), []);
});

test("a look-alike of a known host is a finding", () => {
  const c = new Correlator();
  c.noteModelHost("api.example");
  c.noteConnection("pypi.org.evil.test", "GET", 0, 0);
  c.noteConnection("notpypi.org", "GET", 0, 0);
  assert.equal(c.flush(1, 0, true).length, 2);
});

test("each host is reported once", () => {
  const c = new Correlator();
  c.noteModelHost("api.example");
  c.noteConnection("a.test", "GET", 0, 0);
  assert.equal(c.flush(1, 0, true).length, 1);
  assert.equal(c.flush(2, 0, true).length, 0);
});

test("a run with no model call raises nothing", () => {
  const c = new Correlator();
  c.noteConnection("example.com", "GET", 0, 0);
  assert.deepEqual(c.flush(1, 0, true), []);
});

test("a vendor's sibling host is not a finding, and a two-label model host grants nothing wider", () => {
  const c = new Correlator();
  c.noteModelHost("api.anthropic.com");
  c.noteModelHost("openrouter.ai");
  c.noteModelHost("127.0.0.1");
  for (const host of ["mcp-proxy.anthropic.com", "example.ai", "127.0.0.2"]) c.noteConnection(host, "POST", 1, 0);
  assert.deepEqual(c.flush(1, 0, true).map((u) => u.host), ["example.ai", "127.0.0.2"]);
});
