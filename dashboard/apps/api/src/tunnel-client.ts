/**
 * Tunnel Client for Dashboard
 *
 * Connects to the Core tunnel server to make the local Dashboard
 * accessible via a public URL. Used when running via /og_dashboard.
 */

import WebSocket from "ws";
import http from "http";

// Tunnel protocol types (matching core/src/tunnel/types.ts)
interface TunnelClientMessage {
  type: "register" | "response";
  token?: string;
  requestId?: string;
  statusCode?: number;
  headers?: Record<string, string>;
  body?: string; // base64 encoded
}

interface TunnelServerMessage {
  type: "registered" | "request" | "error";
  publicUrl?: string;
  requestId?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string; // base64 encoded
  error?: string;
}

const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;

let ws: WebSocket | null = null;
let publicUrl: string | null = null;
let reconnectAttempts = 0;
let localPort: number;
let sessionToken: string;
let tunnelUrl: string;

/**
 * Start the tunnel client and connect to the Core tunnel server
 *
 * @param port - Local Dashboard port to forward requests to
 * @param token - Session token for authentication
 * @param coreWsUrl - WebSocket URL of the Core tunnel server
 * @returns Promise that resolves with the public URL
 */
export async function startTunnelClient(
  port: number,
  token: string,
  coreWsUrl: string = "wss://www.openguardrails.com/core/tunnel/ws"
): Promise<string> {
  localPort = port;
  sessionToken = token;
  tunnelUrl = coreWsUrl;

  return new Promise((resolve, reject) => {
    connect((url) => {
      publicUrl = url;
      resolve(url);
    }, reject);
  });
}

/**
 * Connect to the tunnel server
 */
function connect(
  onRegistered: (url: string) => void,
  onError: (err: Error) => void
): void {
  console.log(`[tunnel-client] Connecting to ${tunnelUrl}...`);

  ws = new WebSocket(tunnelUrl);

  ws.on("open", () => {
    console.log("[tunnel-client] Connected to tunnel server");
    reconnectAttempts = 0;

    // Register with our session token
    const registerMsg: TunnelClientMessage = {
      type: "register",
      token: sessionToken,
    };
    ws!.send(JSON.stringify(registerMsg));
  });

  ws.on("message", async (data) => {
    try {
      const message = JSON.parse(data.toString()) as TunnelServerMessage;

      if (message.type === "registered" && message.publicUrl) {
        console.log(`[tunnel-client] Registered! Public URL: ${message.publicUrl}`);
        onRegistered(message.publicUrl);
      } else if (message.type === "request" && message.requestId) {
        // Forward request to local Dashboard
        await handleRequest(message);
      } else if (message.type === "error") {
        console.error(`[tunnel-client] Server error: ${message.error}`);
      }
    } catch (err) {
      console.error("[tunnel-client] Error processing message:", err);
    }
  });

  ws.on("close", () => {
    console.log("[tunnel-client] Disconnected from tunnel server");
    ws = null;

    // Attempt reconnection
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempts++;
      console.log(`[tunnel-client] Reconnecting in ${RECONNECT_DELAY_MS}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
      setTimeout(() => {
        connect(
          (url) => {
            publicUrl = url;
            console.log(`[tunnel-client] Reconnected! Public URL: ${url}`);
          },
          (err) => console.error("[tunnel-client] Reconnection failed:", err)
        );
      }, RECONNECT_DELAY_MS);
    } else {
      console.error("[tunnel-client] Max reconnection attempts reached");
    }
  });

  ws.on("error", (err) => {
    console.error("[tunnel-client] WebSocket error:", err.message);
    if (reconnectAttempts === 0) {
      onError(err);
    }
  });
}

/**
 * Handle an incoming HTTP request from the tunnel server
 */
async function handleRequest(message: TunnelServerMessage): Promise<void> {
  const { requestId, method, path, headers, body } = message;

  if (!requestId || !method || !path) {
    console.error("[tunnel-client] Invalid request message");
    return;
  }

  // Build request options
  const options: http.RequestOptions = {
    hostname: "localhost",
    port: localPort,
    path: path + (path.includes("?") ? "&" : "?") + `token=${sessionToken}`,
    method,
    headers: {
      ...headers,
      host: `localhost:${localPort}`,
    },
  };

  // Forward request to local Dashboard
  const req = http.request(options, (res) => {
    const chunks: Buffer[] = [];

    res.on("data", (chunk) => {
      chunks.push(chunk);
    });

    res.on("end", () => {
      const responseBody = Buffer.concat(chunks);

      // Build response headers
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (typeof value === "string") {
          responseHeaders[key] = value;
        } else if (Array.isArray(value)) {
          responseHeaders[key] = value.join(", ");
        }
      }

      // Send response back through tunnel
      const response: TunnelClientMessage = {
        type: "response",
        requestId,
        statusCode: res.statusCode || 200,
        headers: responseHeaders,
        body: responseBody.toString("base64"),
      };

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
      }
    });
  });

  req.on("error", (err) => {
    console.error(`[tunnel-client] Local request error: ${err.message}`);

    // Send error response
    const response: TunnelClientMessage = {
      type: "response",
      requestId,
      statusCode: 502,
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ error: "Local dashboard error" })).toString("base64"),
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  });

  // Send request body if present
  if (body) {
    req.write(Buffer.from(body, "base64"));
  }

  req.end();
}

/**
 * Get the current public URL (null if not connected)
 */
export function getPublicUrl(): string | null {
  return publicUrl;
}

/**
 * Check if the tunnel is connected
 */
export function isConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

/**
 * Disconnect from the tunnel server
 */
export function disconnect(): void {
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent reconnection
  if (ws) {
    ws.close();
    ws = null;
  }
  publicUrl = null;
}
