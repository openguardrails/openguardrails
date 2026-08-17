"""OpenGuardrails for litellm — the v0.8 agent-direct integration.

One class, registered as a litellm callback:

    from openguardrails_litellm import OpenGuardrails

    # proxy (enforcing): custom_callbacks.py next to config.yaml
    guard = OpenGuardrails()

    # SDK (observe-only):
    import litellm
    litellm.callbacks = [OpenGuardrails()]

No SDK layer, no HTTP dependency: the whole protocol is two hand-rolled
POSTs to /v1/evaluate in `wire.py` (specification/runtime-api.md).
"""

from .hooks import OpenGuardrails, OpenGuardrailsBlockedError
from .wire import EVENT_FIELDS, INTEGRATION, OPTIONAL_EVENT_FIELDS, Wire, __version__

__all__ = [
    "OpenGuardrails",
    "OpenGuardrailsBlockedError",
    "Wire",
    "EVENT_FIELDS",
    "INTEGRATION",
    "OPTIONAL_EVENT_FIELDS",
    "__version__",
]
