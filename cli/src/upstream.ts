/**
 * The way out to the internet when this machine reaches it only through a proxy of its own (a
 * corporate proxy, or v2rayA on a machine in China).
 *
 * sandbox-runtime can chain its proxy to a parent, but only for connections it does not decrypt, and
 * it dials the parent without telling anyone where each connection went. So `run` gives it this
 * relay as the parent: sandbox-runtime still decides what is allowed, the relay writes down every
 * destination it is handed, and passes the bytes on to the real proxy unchanged.
 */
import net from "node:net";

export interface UpstreamProxy {
  url: URL;
  host: string;
  port: number;
}

/** Hosts that never go to the upstream proxy: this machine and the private ranges, which it cannot reach for us. */
export const NO_PROXY = "localhost,127.0.0.0/8,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7,fe80::/10";

export function parseUpstreamProxy(value: string | undefined): UpstreamProxy | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    throw new Error(`the upstream proxy ${value} is not a URL`);
  }
  if (url.protocol !== "http:") throw new Error(`the upstream proxy must be an http:// proxy, not ${url.protocol}//`);
  const port = Number(url.port || 80);
  return { url, host: url.hostname.replace(/^\[|\]$/g, ""), port };
}

/** The upstream proxy from this process's own environment, as other tools on this machine use it. */
export function upstreamFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || undefined;
}

/** Whether a host the sandbox may reach is the upstream proxy itself, which would be a way around this tool. */
export function isUpstreamAddress(upstream: UpstreamProxy, pattern: string): boolean {
  const match = /^(.*?)(?::(\d+))?$/.exec(pattern.replace(/^\[([^\]]+)\]/, "$1"));
  const host = (match?.[1] ?? "").toLowerCase();
  const port = match?.[2] ? Number(match[2]) : null;
  const sameHost = host === upstream.host.toLowerCase() || (["localhost", "127.0.0.1", "::1"].includes(host) && ["localhost", "127.0.0.1", "::1"].includes(upstream.host));
  return sameHost && (port === null || port === upstream.port);
}

export interface Destination {
  method: string;
  host: string;
  port: number;
}

/** The destination a proxy request names: `CONNECT host:port` or an absolute-form URL. */
export function destinationOf(head: string): Destination | null {
  const line = head.slice(0, head.indexOf("\r\n"));
  const [method, target] = line.split(" ");
  if (!method || !target) return null;
  if (method === "CONNECT") {
    const match = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target);
    return match ? { method, host: match[1]!, port: Number(match[2]) } : null;
  }
  try {
    const url = new URL(target);
    return { method, host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) };
  } catch {
    return null;
  }
}

/** The request head with the upstream's credentials added, when it has any. */
export function withProxyAuth(head: string, upstream: UpstreamProxy): string {
  if (!upstream.url.username) return head;
  return setProxyAuth(head, decodeURIComponent(upstream.url.username), decodeURIComponent(upstream.url.password));
}

export interface Relay {
  port: number;
  close(): void;
}

const MAX_HEAD = 64 * 1024;

interface Join {
  dial(): net.Socket;
  /** The head as it should leave; it is read whole before anything is sent on. */
  rewrite(head: string, destination: Destination): string;
  onOpen?(destination: Destination): void;
  onClose?(destination: Destination, bytesUp: number, bytesDown: number): void;
}

/** Reads one proxy request head from `inbound`, then joins it to `dial()` with that head rewritten. */
function joinAfterHead(inbound: net.Socket, join: Join): void {
  let head = Buffer.alloc(0);
  inbound.on("error", () => inbound.destroy());
  const onData = (chunk: Buffer) => {
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) {
      if (head.length > MAX_HEAD) inbound.destroy();
      return;
    }
    inbound.off("data", onData);
    inbound.pause();
    const text = head.subarray(0, end + 4).toString("latin1");
    const destination = destinationOf(text);
    if (!destination) {
      inbound.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    join.onOpen?.(destination);
    let up = 0;
    let down = 0;
    const outbound = join.dial();
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      join.onClose?.(destination, up, down);
    };
    const close = () => {
      inbound.destroy();
      outbound.destroy();
      finish();
    };
    outbound.once("connect", () => {
      const first = Buffer.concat([Buffer.from(join.rewrite(text, destination), "latin1"), head.subarray(end + 4)]);
      up += first.length;
      outbound.write(first);
      // pipe() carries backpressure, so a video download is not held in memory; the listeners only count.
      inbound.on("data", (chunk: Buffer) => void (up += chunk.length));
      outbound.on("data", (chunk: Buffer) => void (down += chunk.length));
      inbound.pipe(outbound);
      outbound.pipe(inbound);
    });
    outbound.on("error", () => {
      if (down === 0 && !inbound.destroyed) {
        outbound.destroy();
        inbound.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nthe proxy did not answer");
        finish();
      } else close();
    });
    inbound.on("close", close);
    // end(), not destroy(): what the far side sent last may still be on its way to the client.
    outbound.on("close", () => {
      if (finished) return;
      inbound.end();
      finish();
    });
  };
  inbound.on("data", onData);
}

/** Replaces any Proxy-Authorization with this one. */
export function setProxyAuth(head: string, user: string, password: string): string {
  const credentials = Buffer.from(`${user}:${password}`).toString("base64");
  const end = head.indexOf("\r\n");
  const rest = head.slice(end).replace(/\r\nproxy-authorization:[^\r]*/gi, "");
  return `${head.slice(0, end)}\r\nProxy-Authorization: Basic ${credentials}${rest}`;
}

/**
 * Only the first request on a connection is rewritten, so a plain-HTTP request asks for the
 * connection to close after it, and the client opens a new one for the next.
 */
export function oneRequestPerConnection(head: string, destination: Destination): string {
  if (destination.method === "CONNECT") return head;
  const end = head.indexOf("\r\n");
  const rest = head.slice(end).replace(/\r\n(proxy-)?connection:[^\r]*/gi, "");
  return `${head.slice(0, end)}\r\nConnection: close${rest}`;
}

/** Listens on a loopback port; each connection is written down, then joined to the upstream proxy. */
export function startUpstreamRelay(
  upstream: UpstreamProxy,
  onOpen: (destination: Destination) => void,
  onClose: (destination: Destination, bytesUp: number, bytesDown: number) => void,
): Promise<Relay> {
  const server = net.createServer((inbound) =>
    joinAfterHead(inbound, { dial: () => net.connect(upstream.port, upstream.host), rewrite: (head, destination) => withProxyAuth(oneRequestPerConnection(head, destination), upstream), onOpen, onClose }),
  );
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      resolve({ port: address.port, close: () => server.close() });
    });
  });
}

/**
 * This machine's side of the proxy port an agent names inside the Linux sandbox. sandbox-runtime's
 * proxy only takes requests that carry its per-run credentials, which an agent's own proxy setting
 * does not, so they are added here before the request reaches it.
 */
export function startProxyAuthBridge(socketPath: string, proxyPort: number, user: string, token: string): Promise<net.Server> {
  const server = net.createServer((inbound) =>
    joinAfterHead(inbound, {
      dial: () => net.connect(proxyPort, "127.0.0.1"),
      rewrite: (head, destination) => setProxyAuth(oneRequestPerConnection(head, destination), user, token),
    }),
  );
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}
