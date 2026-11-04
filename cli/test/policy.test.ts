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

test("devices are bound into the sandbox's own /dev, and only device paths", async () => {
  const { passDevices, gpuDevices } = await import("../src/policy.js");
  const wrapped = "bwrap --ro-bind / / --dev /dev --unshare-pid -- bash -c 'x'";
  assert.equal(passDevices(wrapped, []), wrapped);
  assert.match(passDevices(wrapped, ["/dev/nvidia0", "/dev/nvidiactl"]), / --dev \/dev --dev-bind \/dev\/nvidia0 \/dev\/nvidia0 --dev-bind \/dev\/nvidiactl \/dev\/nvidiactl --unshare-pid/);
  assert.throws(() => passDevices(wrapped, ["/etc/shadow"]), /not a device path/);
  assert.throws(() => passDevices(wrapped, ["/dev/../etc"]), /not a device path/);
  assert.throws(() => passDevices(wrapped, ["/dev/x; rm -rf /"]), /not a device path/);
  assert.throws(() => passDevices("bwrap --unshare-pid", ["/dev/nvidia0"]), /unexpected command/);
  const fake = (dir: string) => (dir === "/dev" ? ["nvidia0", "nvidia1", "nvidiactl", "nvidia-uvm", "nvidia-uvm-tools", "nvidia-modeset", "nvme0", "null"] : ["nvidia-cap1"]);
  assert.deepEqual(gpuDevices(fake), ["/dev/nvidia0", "/dev/nvidia1", "/dev/nvidiactl", "/dev/nvidia-uvm", "/dev/nvidia-uvm-tools", "/dev/nvidia-modeset", "/dev/nvidia-caps/nvidia-cap1"]);
  assert.deepEqual(gpuDevices(() => ["null", "tty"]), []);
});

test("with a GPU, every socket on the machine is hidden, and a per-program socket by its directory", async () => {
  const { socketsToHide } = await import("../src/policy.js");
  const found: Record<string, string[]> = {
    "/tmp": ["/tmp/ssh-XXXX1b/agent.2129407", "/tmp/com.google.Chrome.hp/SingletonSocket", "/tmp/srt-mux-1-0.sock"],
    "/run": ["/run/xrdp/sockdir/xrdpapi_10"],
    "/var/run": [],
  };
  const hidden = socketsToHide(1001, (root) => found[root] ?? []);
  for (const path of ["/run/user/1001", "/var/run/docker.sock", "/run/docker.sock", "/run/dbus", "/tmp/.X11-unix", "/tmp/ssh-XXXX1b", "/tmp/com.google.Chrome.hp", "/tmp/srt-mux-1-0.sock", "/run/xrdp/sockdir/xrdpapi_10"]) {
    assert.ok(hidden.includes(path), path);
  }
  assert.ok(!hidden.includes("/tmp"));
});
