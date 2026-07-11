"""OpenAI Chat Completions binding — POST /v1/chat/completions."""
from __future__ import annotations

from ..engine import GatewayDecision
from .base import Response, _ogr_headers, register


class OpenAIChat:
    name = "openai"
    request_paths = ("/v1/chat/completions",)

    def parse(self, body: dict) -> dict:
        return {
            "protocol": self.name,
            "model": body.get("model"),
            "messages": body.get("messages", []),
            "tools": body.get("tools") or body.get("functions") or [],
            "caller": body.get("user", "anonymous"),
        }

    def block_response(self, d: GatewayDecision) -> Response:
        return 403, {
            "error": {
                "message": "Request blocked by OpenGuardrails policy: "
                           + "; ".join(d.reason_summary()) or "policy violation",
                "type": "ogr_policy_block",
                "code": "guardrails_blocked",
                "ogr": {"decision": d.decision, "guard_id": d.guard_id,
                        "categories": _cats(d)},
            }
        }, _ogr_headers(d)

    def approval_response(self, d: GatewayDecision) -> Response:
        return 409, {
            "error": {
                "message": "Human approval required by OpenGuardrails policy: "
                           + "; ".join(d.reason_summary()),
                "type": "ogr_approval_required",
                "code": "guardrails_require_approval",
                "ogr": {"decision": d.decision, "guard_id": d.guard_id,
                        "categories": _cats(d)},
            }
        }, _ogr_headers(d)

    def stub_completion(self, norm: dict, note: str) -> Response:
        return 200, {
            "id": "chatcmpl-ogr-stub",
            "object": "chat.completion",
            "model": norm.get("model", "stub"),
            "choices": [{
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": note},
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }, {}


register(OpenAIChat())


def _cats(d: GatewayDecision) -> list[dict]:
    seen, out = set(), []
    for v in d.verdicts:
        for c in v.categories:
            if c.id not in seen:
                seen.add(c.id)
                out.append({"id": c.id, "domain": c.domain, "score": c.score})
    return out
