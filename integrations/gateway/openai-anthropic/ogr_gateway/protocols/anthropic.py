"""Anthropic Messages binding — POST /v1/messages."""
from __future__ import annotations

from ..engine import GatewayDecision
from .base import Response, _ogr_headers, register


class AnthropicMessages:
    name = "anthropic"
    request_paths = ("/v1/messages",)

    def parse(self, body: dict) -> dict:
        # Anthropic carries the system prompt in a top-level `system` field.
        messages = []
        if body.get("system"):
            messages.append({"role": "system", "content": body["system"]})
        messages.extend(body.get("messages", []))
        return {
            "protocol": self.name,
            "model": body.get("model"),
            "messages": messages,
            "tools": body.get("tools") or [],
            "caller": (body.get("metadata") or {}).get("user_id", "anonymous"),
        }

    def block_response(self, d: GatewayDecision) -> Response:
        return 403, {
            "type": "error",
            "error": {
                "type": "ogr_policy_block",
                "message": "Request blocked by OpenGuardrails policy: "
                           + "; ".join(d.reason_summary()),
                "ogr": {"decision": d.decision, "guard_id": d.guard_id,
                        "categories": _cats(d)},
            },
        }, _ogr_headers(d)

    def approval_response(self, d: GatewayDecision) -> Response:
        return 409, {
            "type": "error",
            "error": {
                "type": "ogr_approval_required",
                "message": "Human approval required by OpenGuardrails policy: "
                           + "; ".join(d.reason_summary()),
                "ogr": {"decision": d.decision, "guard_id": d.guard_id,
                        "categories": _cats(d)},
            },
        }, _ogr_headers(d)

    def stub_completion(self, norm: dict, note: str) -> Response:
        return 200, {
            "id": "msg-ogr-stub",
            "type": "message",
            "role": "assistant",
            "model": norm.get("model", "stub"),
            "content": [{"type": "text", "text": note}],
            "stop_reason": "end_turn",
            "usage": {"input_tokens": 0, "output_tokens": 0},
        }, {}


register(AnthropicMessages())


def _cats(d: GatewayDecision) -> list[dict]:
    seen, out = set(), []
    for v in d.verdicts:
        for c in v.categories:
            if c.id not in seen:
                seen.add(c.id)
                out.append({"id": c.id, "domain": c.domain, "score": c.score})
    return out
