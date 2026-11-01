import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalTarget, openLoopbackPort } from "../src/policy.js";

test("this machine and metadata endpoints are local", () => {
  for (const host of ["localhost", "a.localhost", "127.0.0.1", "127.9.9.9", "::1", "[::1]", "::ffff:127.0.0.1", "169.254.169.254", "0.0.0.0", "100.100.100.200", "metadata.google.internal"]) {
    assert.equal(isLocalTarget(host), true, host);
  }
});

test("LAN and public hosts are not", () => {
  for (const host of ["10.9.0.3", "192.168.1.1", "example.com", "127.example.com", "1270.0.0.1"]) {
    assert.equal(isLocalTarget(host), false, host);
  }
});

test("opening a port adds one rule and refuses an unknown profile", () => {
  const profile = `(allow network-outbound (remote ip "localhost:5000"))`;
  const out = openLoopbackPort(profile, 4180);
  assert.ok(out.includes(`localhost:5000`) && out.includes(`localhost:4180`));
  assert.ok(!out.includes("localhost:*"));
  assert.throws(() => openLoopbackPort("no rule", 4180), /unexpected profile/);
});
