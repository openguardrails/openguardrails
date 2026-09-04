"""MCP transport wiring around `Gateway`.

  streamable-http (default): agents connect with `Authorization: Bearer <principal token>`;
                             the token IS the identity, verified by StaticTokenVerifier.
  stdio (`--stdio`):         one identity from $OGR_MCP_TOKEN; for a single local agent.

The upstream server is spawned once over stdio with the credentials from the gateway's
config/environment and kept for the gateway's lifetime."""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import os
import sys

import mcp_types as types
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.server.auth.middleware.auth_context import AuthContextMiddleware, get_access_token
from mcp.server.auth.middleware.bearer_auth import BearerAuthBackend
from mcp.server.auth.provider import AccessToken, TokenVerifier
from starlette.middleware.authentication import AuthenticationMiddleware
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from . import __version__
from .config import Config, Principal, load
from .gateway import Gateway
from .ledger import MemoryLedger, SqliteLedger


class StdioUpstream:
    def __init__(self, cfg: Config):
        self.name = cfg.upstream.name
        self.cfg = cfg
        self._stack = contextlib.AsyncExitStack()
        self.session: ClientSession | None = None

    async def __aenter__(self):
        # The upstream gets the gateway's environment minus proxy settings (a SOCKS proxy here
        # breaks httpx-based servers without socksio) plus the configured credential.
        env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
        env.update(self.cfg.upstream.env)
        params = StdioServerParameters(command=self.cfg.upstream.command, args=list(self.cfg.upstream.args), env=env)
        r, w = await self._stack.enter_async_context(stdio_client(params))
        self.session = await self._stack.enter_async_context(ClientSession(r, w))
        await self.session.initialize()
        return self

    async def __aexit__(self, *exc):
        await self._stack.aclose()

    async def list_tools(self) -> list[types.Tool]:
        return (await self.session.list_tools()).tools

    async def call_tool(self, name: str, args: dict) -> types.CallToolResult:
        return await self.session.call_tool(name, args or {})


class StaticTokenVerifier(TokenVerifier):
    def __init__(self, cfg: Config):
        self.cfg = cfg

    async def verify_token(self, token: str) -> AccessToken | None:
        p = self.cfg.principal_for(token)
        if p is None:
            return None
        return AccessToken(token=token, client_id=p.agent_id, scopes=[p.workspace], subject=p.user or None)


def build_server(gw: Gateway, fixed: Principal | None) -> Server:
    def principal() -> Principal | None:
        if fixed is not None:
            return fixed
        tok = get_access_token()
        return gw.cfg.principal_for(tok.token) if tok else None

    async def on_list_tools(ctx, params):
        return types.ListToolsResult(tools=await gw.tools_for(principal()))

    async def on_call_tool(ctx, params: types.CallToolRequestParams):
        p = principal()
        if p is None:
            return types.CallToolResult(content=[types.TextContent(type="text", text='{"_ogr":{"decision":"block","stage":"identity","reason":"unknown principal"}}')], is_error=True)
        return await gw.call(p, params.name, dict(params.arguments or {}))

    return Server("ogr-mcp-gateway", version=__version__, on_list_tools=on_list_tools, on_call_tool=on_call_tool)


def build_http_app(server: Server, cfg: Config):
    """streamable_http_app() installs the bearer middleware only when full OAuth `auth` settings are
    given; we are a plain resource server with static tokens, so we install the same two
    middlewares ourselves. RequireAuthMiddleware on the route then sees an authenticated user."""
    verifier = StaticTokenVerifier(cfg)
    app = server.streamable_http_app(stateless_http=True, token_verifier=verifier, host=cfg.host)
    app.add_middleware(AuthContextMiddleware)
    app.add_middleware(AuthenticationMiddleware, backend=BearerAuthBackend(verifier))
    return app


async def run(cfg: Config, stdio: bool) -> None:
    ledger = SqliteLedger(cfg.ledger) if cfg.ledger else MemoryLedger()
    async with StdioUpstream(cfg) as up:
        gw = Gateway(cfg, up, ledger)
        n = len(await gw.tools())
        print(f"[ogr-mcp-gateway {__version__}] upstream {cfg.upstream.name}: {n} tools; "
              f"{len(cfg.principals)} principals; mandates for {sorted(cfg.mandates)}; "
              f"pretrade={'on' if cfg.pretrade else 'off'}; runtime={'on' if cfg.runtime else 'off'}", file=sys.stderr)
        if stdio:
            p = cfg.principal_for(os.environ.get("OGR_MCP_TOKEN", ""))
            if p is None:
                sys.exit("--stdio needs OGR_MCP_TOKEN set to a configured principal token")
            server = build_server(gw, p)
            async with stdio_server() as (r, w):
                await server.run(r, w, server.create_initialization_options())
        else:
            import uvicorn
            server = build_server(gw, None)
            app = build_http_app(server, cfg)
            print(f"[ogr-mcp-gateway] listening on http://{cfg.host}:{cfg.port}/mcp", file=sys.stderr)
            await uvicorn.Server(uvicorn.Config(app, host=cfg.host, port=cfg.port, log_level="warning")).serve()


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ogr-mcp-gateway", description="OpenGuardrails MCP gateway")
    ap.add_argument("--config", "-c", default="config.json")
    ap.add_argument("--stdio", action="store_true", help="serve one principal over stdio (identity from $OGR_MCP_TOKEN)")
    ap.add_argument("--check", action="store_true", help="load config, list upstream tools, exit")
    ap.add_argument("--env-file", help="KEY=VALUE lines to load into the environment before reading the config")
    a = ap.parse_args(argv)
    if a.env_file:
        for line in open(a.env_file, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1); os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    cfg = load(a.config)
    if a.check:
        async def _chk():
            async with StdioUpstream(cfg) as up:
                gw = Gateway(cfg, up, MemoryLedger())
                for p in cfg.principals:
                    ts = await gw.tools_for(p)
                    print(f"{p.agent_id:14} {p.workspace:14} sees {len(ts):3} tools")
        asyncio.run(_chk()); return
    asyncio.run(run(cfg, a.stdio))


if __name__ == "__main__":
    main()
