import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeGatewayPort, exposePort, isLocalTarget, openLoopbackPort } from "../src/policy.js";

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

test("on Linux the gateway relay starts beside sandbox-runtime's own, before seccomp", () => {
  const script = "bash -c '{ socat TCP4-LISTEN:1080 UNIX-CONNECT:/tmp/s.sock; } >/dev/null 2>&1 &\n_srt_socks=$!\ntrap 'rc=$?' EXIT\napply-seccomp bash -c 'dsh'";
  const out = bridgeGatewayPort(script, 18190, "/tmp/openguardrails-abc/gateway.sock");
  const lines = out.split("\n");
  assert.equal(lines[1], "_srt_socks=$!");
  assert.equal(lines[2], "{ socat TCP4-LISTEN:18190,bind=127.0.0.1,fork,reuseaddr,backlog=4096 UNIX-CONNECT:/tmp/openguardrails-abc/gateway.sock; } >/dev/null 2>&1 &");
  assert.ok(lines.indexOf(lines[2]!) < lines.findIndex((line) => line.startsWith("apply-seccomp")));
  assert.throws(() => bridgeGatewayPort("no anchor", 18190, "/tmp/x.sock"), /unexpected script/);
  assert.throws(() => bridgeGatewayPort(script, 18190, "/tmp/it's.sock"), /unexpected script/);
});

test("an exposed port's relay inside the sandbox turns it into a Unix socket, before seccomp", () => {
  const script = "x &\n_srt_socks=$!\ntrap 'rc=$?' EXIT\napply-seccomp bash -c 'dsh web'";
  const out = exposePort(script, 18799, "/tmp/openguardrails-abc/expose-18799.sock");
  assert.equal(out.split("\n")[2], "{ socat UNIX-LISTEN:/tmp/openguardrails-abc/expose-18799.sock,fork,reuseaddr TCP4:127.0.0.1:18799; } >/dev/null 2>&1 &");
  assert.throws(() => exposePort("no anchor", 18799, "/tmp/x.sock"), /unexpected script/);
});
