"""A fake langchain/langgraph surface — just enough of it.

The integration duck-types langchain-core (``.type``, ``.content``,
``.tool_calls``, ``.tool_call_id``, ``.usage_metadata``,
``.response_metadata``), so these fakes ARE the interface under test:
plain objects carrying exactly the attributes the real message classes
carry, with none of the real packages installed.
"""

from __future__ import annotations

from typing import Any


class FakeMessage:
    """Shape-compatible with a langchain-core BaseMessage."""

    def __init__(self, type: str, content: Any, **attrs: Any) -> None:
        self.type = type
        self.content = content
        for name, value in attrs.items():
            setattr(self, name, value)


def system(content: str) -> FakeMessage:
    return FakeMessage("system", content)


def human(content: str) -> FakeMessage:
    return FakeMessage("human", content)


def tool_result(content: str, tool_call_id: str) -> FakeMessage:
    return FakeMessage("tool", content, tool_call_id=tool_call_id)


def ai(
    content: Any = "",
    tool_calls: list | None = None,
    usage_metadata: dict | None = None,
    response_metadata: dict | None = None,
) -> FakeMessage:
    return FakeMessage(
        "ai",
        content,
        tool_calls=tool_calls or [],
        usage_metadata=usage_metadata,
        response_metadata=response_metadata or {},
    )


class FakeTool:
    """Shape-compatible with a langchain-core BaseTool."""

    def __init__(self, name: str, description: str = "", args: dict | None = None) -> None:
        self.name = name
        self.description = description
        self.args = args or {}


class FakeChatModel:
    """Shape-compatible with a chat model: records what it was invoked with,
    answers from a script, and never calls any network."""

    def __init__(self, responses: list | None = None) -> None:
        self.responses = list(responses) if responses else []
        self.calls: list[list] = []
        self.bound_tools: list | None = None

    def invoke(self, messages: list, config: Any = None, **kwargs: Any) -> FakeMessage:
        self.calls.append(list(messages))
        return self.responses.pop(0) if self.responses else ai("ok")

    def bind_tools(self, tools: list, **kwargs: Any) -> "FakeChatModel":
        bound = FakeChatModel(self.responses)
        bound.calls = self.calls  # share the recorder across the rebind
        bound.bound_tools = list(tools)
        return bound
