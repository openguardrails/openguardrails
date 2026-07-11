"""OpenGuardrails reference gateway.

The gateway altitude of OGR: it terminates an LLM wire protocol, normalizes the
request (and response) into `GuardEvent`s, and enforces one policy through the
published `openguardrails` runtime — the same runtime the agent-hook and sandbox
altitudes use. This package is a *binding*, not a fork of the policy model.
"""
from .engine import GatewayEngine, GatewayDecision

__all__ = ["GatewayEngine", "GatewayDecision"]
__version__ = "0.1.0"
