"""OpenGuardrails ↔ LangGraph — the v0.8 agent-direct integration.

A LangGraph agent holds its own model call, so the recipe of
``specification/runtime-api.md`` fits directly: wrap the chat model with
:func:`guard` and every step is judged twice — ``step/request`` before the
provider sees it, ``step/response`` before the agent acts on it — sharing
one minted ``step_id``. A block raises :class:`GuardrailBlocked`.

No SDK, no langchain import: the wire is stdlib ``urllib``
(:class:`OgrClient`), and message conversion duck-types the langchain-core
surface, so this package imports and tests without langgraph installed.
"""

from .client import INTEGRATION, OgrClient
from .guard import GuardedChatModel, GuardrailBlocked, guard

__all__ = [
    "INTEGRATION",
    "OgrClient",
    "GuardedChatModel",
    "GuardrailBlocked",
    "guard",
]
