/**
 * Contract test for the WorkPnP client (CONTRACT_v0.md §2) against a mocked
 * fetch — asserts EXACT paths, methods, headers and bodies. The live server is
 * built in parallel; this test is the interface freeze on our side.
 */
import { describe, expect, it, vi } from "vitest";
import { WorkPnpClient, WorkPnpError } from "../src/workpnp/client.js";
import type { Forecast } from "../src/core/types.js";

const BASE = "http://localhost:8787";

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

function client(fetchImpl: typeof fetch, apiKey?: string): WorkPnpClient {
  return new WorkPnpClient(
    { fetchImpl, ...(apiKey ? { apiKey } : {}) },
    { WORKPNP_URL: BASE }, // isolated env: ignore the real process.env
  );
}

describe("WorkPnpClient", () => {
  it("register: POST /api/workers/register, no auth header, exact body", async () => {
    const f = mockFetch(200, { workerId: "wk_1", apiKey: "secret" });
    const res = await client(f).register({ name: "thomas", agentKind: "openthomas" });
    expect(res).toEqual({ workerId: "wk_1", apiKey: "secret" });

    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/workers/register`);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["authorization"]).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ name: "thomas", agentKind: "openthomas" });
  });

  it("register passes walletAddress through when given", async () => {
    const f = mockFetch(200, { workerId: "wk_1", apiKey: "k" });
    await client(f).register({ name: "t", agentKind: "openthomas", walletAddress: "0xabc" });
    const [, init] = f.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ name: "t", agentKind: "openthomas", walletAddress: "0xabc" });
  });

  it("me: GET /api/me with Bearer apiKey", async () => {
    const f = mockFetch(200, { workerId: "wk_1", name: "thomas" });
    await client(f, "key123").me();
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/me`);
    expect(init.method).toBe("GET");
    expect(init.headers["authorization"]).toBe("Bearer key123");
    expect(init.body).toBeUndefined();
  });

  it("me without an apiKey fails fast without any network call", async () => {
    const f = mockFetch(200, {});
    await expect(client(f).me()).rejects.toThrow(/WORKPNP_API_KEY/);
    expect(f).not.toHaveBeenCalled();
  });

  it("listOpenWork: GET /api/work?status=open, public (no auth header)", async () => {
    const f = mockFetch(200, [{ id: "w_1", status: "open" }]);
    const items = await client(f, "key123").listOpenWork();
    expect(items).toEqual([{ id: "w_1", status: "open" }]);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/work?status=open`);
    expect(init.method).toBe("GET");
    expect(init.headers["authorization"]).toBeUndefined();
  });

  it("getWork: GET /api/work/:id", async () => {
    const f = mockFetch(200, { id: "w_abc123" });
    await client(f).getWork("w_abc123");
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/api/work/w_abc123`);
  });

  it("submitForecast: POST /api/work/:id/submit with Bearer auth and the raw Forecast as body", async () => {
    const forecast: Forecast = {
      schema: "openthomas/forecast@0.1",
      workId: "w_abc123",
      marketSlug: "fifwc-usa-par-2026-06-12-usa",
      tokenLabel: "United States",
      p: 0.47,
      ci: [0.42, 0.52],
      prior: { value: 0.45, method: "elo_poisson+market_devig" },
      evidence: [{ source: "elo", claim: "USA 1726 vs PAR 1834", effect: "-0.02", url: "", ts: "2026-06-12T00:00:00Z" }],
      ts: "2026-06-12T00:00:00Z",
    };
    const f = mockFetch(200, { submissionId: "s_1", status: "accepted" });
    const res = await client(f, "key123").submitForecast("w_abc123", forecast);
    expect(res).toEqual({ submissionId: "s_1", status: "accepted" });

    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/work/w_abc123/submit`);
    expect(init.method).toBe("POST");
    expect(init.headers["authorization"]).toBe("Bearer key123");
    expect(init.headers["content-type"]).toBe("application/json");
    // The body is the Forecast JSON itself — not wrapped in an envelope.
    expect(JSON.parse(init.body)).toEqual(forecast);
  });

  it("surfaces 400 {error, reason} as a WorkPnpError", async () => {
    const f = mockFetch(400, { error: "validation failed", reason: "p out of range" });
    const err = await client(f, "key123")
      .submitForecast("w_1", { p: 2 } as unknown as Forecast)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkPnpError);
    expect((err as WorkPnpError).status).toBe(400);
    expect((err as WorkPnpError).reason).toBe("p out of range");
    expect((err as WorkPnpError).message).toContain("validation failed");
  });

  it("strips trailing slashes from WORKPNP_URL", async () => {
    const f = mockFetch(200, []);
    const c = new WorkPnpClient({ fetchImpl: f }, { WORKPNP_URL: "http://x.test:8787///" });
    await c.listOpenWork();
    expect(f.mock.calls[0]![0]).toBe("http://x.test:8787/api/work?status=open");
  });
});
