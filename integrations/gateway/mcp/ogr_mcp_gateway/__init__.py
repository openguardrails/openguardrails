"""OpenGuardrails MCP gateway: one MCP server in front of another, judging every tool call.

    agent --MCP (streamable-http, bearer token)--> gateway --MCP (stdio)--> upstream server
                                                    │
                                                    ├── mandate  (specification/mandate.md, argument-level, per workspace)
                                                    ├── pretrade (stateful account limits — the OMS layer the mandate spec
                                                    │             says is not its job; optional, capability order.*)
                                                    ├── runtime  (POST /v1/evaluate — permission rules, semantic guards, console)
                                                    └── audit    (one JSONL line per call, decision and why)

Upstream credentials live only in the gateway's environment. An agent holds a per-principal
token that maps to an identity four-tuple and, through the workspace, to exactly one mandate.
"""
__version__ = "0.1.0"
INTEGRATION = f"ogr-mcp-gateway/{__version__}"
