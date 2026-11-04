import assert from "node:assert/strict";
import net from "node:net";
import { test } from "node:test";
import { aliasProxyPort, proxyCredentials } from "../src/policy.js";
import { destinationOf, isUpstreamAddress, oneRequestPerConnection, setProxyAuth, parseUpstreamProxy, startUpstreamRelay, upstreamFromEnv, withProxyAuth } from "../src/upstream.js";

test("an upstream proxy is an http:// URL, with or without the scheme", () => {
  assert.deepEqual(parseUpstreamProxy("127.0.0.1:20171") && { host: "127.0.0.1", port: 20171 }, { host: "127.0.0.1", port: 20171 });
  assert.equal(parseUpstreamProxy("http://proxy.corp:8080")?.port, 8080);
  assert.equal(parseUpstreamProxy(undefined), null);
  assert.throws(() => parseUpstreamProxy("socks5://127.0.0.1:20170"), /http:\/\//);
  assert.equal(upstreamFromEnv({ https_proxy: "http://127.0.0.1:20171" }), "http://127.0.0.1:20171");
  assert.equal(upstreamFromEnv({}), undefined);
});

test("allowing the upstream proxy itself is recognised, by any loopback spelling", () => {
  const upstream = parseUpstreamProxy("http://127.0.0.1:20171")!;
  assert.equal(isUpstreamAddress(upstream, "127.0.0.1:20171"), true);
  assert.equal(isUpstreamAddress(upstream, "localhost:20171"), true);
  assert.equal(isUpstreamAddress(upstream, "127.0.0.1"), true);
  assert.equal(isUpstreamAddress(upstream, "127.0.0.1:8888"), false);
  assert.equal(isUpstreamAddress(upstream, "example.com"), false);
});

test("the destination is read from CONNECT and from an absolute-form request", () => {
  assert.deepEqual(destinationOf("CONNECT www.youtube.com:443 HTTP/1.1\r\nHost: x\r\n\r\n"), { method: "CONNECT", host: "www.youtube.com", port: 443 });
  assert.deepEqual(destinationOf("CONNECT [2001:db8::1]:443 HTTP/1.1\r\n\r\n"), { method: "CONNECT", host: "2001:db8::1", port: 443 });
  assert.deepEqual(destinationOf("GET http://example.com/a HTTP/1.1\r\n\r\n"), { method: "GET", host: "example.com", port: 80 });
  assert.equal(destinationOf("GET /a HTTP/1.1\r\n\r\n"), null);
});

test("the upstream's credentials replace any the client sent", () => {
  const upstream = parseUpstreamProxy("http://u%40x:p@127.0.0.1:3128")!;
  const head = withProxyAuth("CONNECT a:443 HTTP/1.1\r\nProxy-Authorization: Basic zzz\r\n\r\n", upstream);
  assert.match(head, /^CONNECT a:443 HTTP\/1\.1\r\nProxy-Authorization: Basic /);
  assert.equal(head.match(/proxy-authorization/gi)?.length, 1);
  assert.equal(Buffer.from(/Basic (\S+)/.exec(head)![1]!, "base64").toString(), "u@x:p");
});

test("the relay writes down each tunnel and passes its bytes through to the upstream unchanged", async () => {
  const received: string[] = [];
  const fake = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      received.push(chunk.toString("latin1"));
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.on("data", (more) => socket.write(more));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const upstream = parseUpstreamProxy(`http://127.0.0.1:${(fake.address() as net.AddressInfo).port}`)!;
  const opened: string[] = [];
  let closedWith: [number, number] | null = null;
  const done = new Promise<void>((resolve) => {
    void startUpstreamRelay(upstream, (d) => opened.push(`${d.method} ${d.host}:${d.port}`), (_d, up, down) => {
      closedWith = [up, down];
      resolve();
    }).then((relay) => {
      const client = net.connect(relay.port, "127.0.0.1", () => client.write("CONNECT www.youtube.com:443 HTTP/1.1\r\nHost: www.youtube.com:443\r\n\r\n"));
      let reply = "";
      client.on("data", (chunk) => {
        reply += chunk.toString();
        if (reply.includes("\r\n\r\n") && !reply.includes("ping")) client.write("ping");
        if (reply.endsWith("ping")) {
          client.end();
          relay.close();
        }
      });
    });
  });
  await done;
  fake.close();
  assert.deepEqual(opened, ["CONNECT www.youtube.com:443"]);
  assert.match(received[0]!, /^CONNECT www\.youtube\.com:443 HTTP\/1\.1\r\n/);
  assert.ok(closedWith![0] > 4 && closedWith![1] > 4);
});

test("a dead upstream is answered with 502, not a hang", async () => {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  probe.close();
  const relay = await startUpstreamRelay(parseUpstreamProxy(`http://127.0.0.1:${port}`)!, () => undefined, () => undefined);
  const reply = await new Promise<string>((resolve) => {
    const client = net.connect(relay.port, "127.0.0.1", () => client.write("CONNECT a.example:443 HTTP/1.1\r\n\r\n"));
    let text = "";
    client.on("data", (chunk) => (text += chunk));
    client.on("close", () => resolve(text));
  });
  relay.close();
  assert.match(reply, /^HTTP\/1\.1 502 /);
});

test("inside a Linux sandbox the agent's own proxy port is relayed out to this machine, before seccomp", () => {
  const script = "x &\n_srt_http=$!\ny &\n_srt_socks=$!\nexport HTTP_PROXY=http://cmd%3D:tok123@localhost:3128\napply-seccomp bash -c 'yt-dlp'";
  const out = aliasProxyPort(script, 20171, "/tmp/og/proxy.sock");
  assert.ok(out.indexOf("TCP4-LISTEN:20171,bind=127.0.0.1") > out.indexOf("_srt_socks=$!"));
  assert.ok(out.indexOf("UNIX-CONNECT:/tmp/og/proxy.sock") < out.indexOf("apply-seccomp"));
  assert.throws(() => aliasProxyPort("no anchor", 20171, "/tmp/og/proxy.sock"), /unexpected script/);
  assert.deepEqual(proxyCredentials(script), { user: "cmd=", token: "tok123" });
  assert.equal(proxyCredentials("nothing"), null);
});

test("a plain-HTTP request is sent one per connection, with the proxy's credentials", () => {
  const head = "GET http://a.example/ HTTP/1.1\r\nHost: a.example\r\nProxy-Connection: keep-alive\r\nConnection: keep-alive\r\n\r\n";
  const out = setProxyAuth(oneRequestPerConnection(head, destinationOf(head)!), "u", "t");
  assert.equal(out.match(/connection:/gi)?.length, 1);
  assert.match(out, /\r\nConnection: close\r\n/);
  assert.match(out, /Proxy-Authorization: Basic dTp0\r\n/);
  const connect = "CONNECT a:443 HTTP/1.1\r\n\r\n";
  assert.equal(oneRequestPerConnection(connect, destinationOf(connect)!), connect);
});
