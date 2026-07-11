"""OpenGuardrails ↔ LangGraph — guard a custom LangGraph agent at the agent-hook
altitude.

The decision core (``_engine``: ``GuardEngine`` / ``build_engine`` / ``ToolDecision``)
imports no ``langgraph`` and is testable offline. The enforcement surfaces
(``OpenGuardrailsToolNode`` / ``guard`` / ``ogr_guard``) import ``langgraph`` +
``langchain-core``, so they are exposed lazily — ``import ..._engine`` works
without the ``[langgraph]`` extra installed.
"""

from ._engine import GuardEngine, ToolDecision, build_engine

__all__ = [
    "GuardEngine",
    "ToolDecision",
    "build_engine",
    "OpenGuardrailsToolNode",
    "guard",
    "ogr_guard",
]

_LANGGRAPH_EXPORTS = {"OpenGuardrailsToolNode", "guard", "ogr_guard"}


def __getattr__(name):  # PEP 562 lazy export — keeps langgraph an optional import
    if name in _LANGGRAPH_EXPORTS:
        from . import toolnode

        return getattr(toolnode, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
