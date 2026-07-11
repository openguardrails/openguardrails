"""Protocol bindings — translate a wire format to/from the OGR normal form.

A `Protocol` is the only thing that knows a vendor's request/response JSON shape.
Everything else in the gateway speaks the normalized dict. Adding a protocol
(Gemini, Cohere, Bedrock) is one new module — the engine and server never change.
"""
from __future__ import annotations

from typing import Any, Protocol as TypingProtocol

from ..engine import GatewayDecision

# (status_code, json_body, extra_headers)
Response = tuple[int, dict, dict]


class Protocol(TypingProtocol):
    name: str
    request_paths: tuple[str, ...]

    def parse(self, body: dict) -> dict:
        """Wire request -> normalized {protocol, model, messages, ...}."""
        ...

    def block_response(self, d: GatewayDecision) -> Response:
        """Render an OGR block in this vendor's error envelope."""
        ...

    def approval_response(self, d: GatewayDecision) -> Response:
        """Render a 'human approval required' result in this vendor's shape."""
        ...

    def stub_completion(self, norm: dict, note: str) -> Response:
        """Offline stand-in for an upstream completion (demo mode)."""
        ...


_REGISTRY: dict[str, Protocol] = {}


def register(proto: Protocol) -> Protocol:
    for path in proto.request_paths:
        _REGISTRY[path] = proto
    return proto


def for_path(path: str) -> Protocol | None:
    return _REGISTRY.get(path.rstrip("/") or "/") or _REGISTRY.get(path)


def all_paths() -> list[str]:
    return sorted(_REGISTRY)


def _ogr_headers(d: GatewayDecision) -> dict[str, str]:
    h = {"x-ogr-decision": d.decision, "x-ogr-guard-id": d.guard_id}
    if d.redactions:
        h["x-ogr-redactions"] = str(len(d.redactions))
    return h
