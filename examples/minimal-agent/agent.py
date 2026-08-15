#!/usr/bin/env python3
"""The minimal OGR integration: your own agent.

This is the runnable form of the example in
specification/runtime-api.md § "The minimal integration: your own agent" —
a tiny real agent loop (OpenAI chat wire format, two toy tools executed
locally) with the two evaluate calls added at the loop's seams.

One endpoint, two calls per model call, fail-open:

    python agent.py "Read notes.txt and total the refunds."

Configuration (environment):
    OGR_RUNTIME_URL  your OGR runtime's base URL   (default: the local mock)
    OGR_API_KEY      your organization API key      (default: ogr_demo)
    LLM_BASE_URL     any OpenAI-compatible endpoint (default: the local mock)
    LLM_API_KEY      that endpoint's API key
    LLM_MODEL        model name to request

Offline demo against the bundled mocks: ./demo.sh
"""

import json
import os
import sys
import uuid

import requests

OGR = os.environ.get("OGR_RUNTIME_URL", "http://127.0.0.1:8471")  # your runtime's base URL
KEY = os.environ.get("OGR_API_KEY", "ogr_demo")                   # your organization API key

LLM = os.environ.get("LLM_BASE_URL", "http://127.0.0.1:8472")     # any OpenAI-compatible endpoint
LLM_KEY = os.environ.get("LLM_API_KEY", "sk-demo")
MODEL = os.environ.get("LLM_MODEL", "gpt-5")

# The identity five-tuple. All five always present; "" = nothing to assert
# (the runtime then derives identity from the API key).
IDENTITY = {
    "agent_id":        "invoice-bot",     # WHICH agent — unique in your org;
                                          #   policy and inventory key on it
    "agent_type":      "my-harness",      # what KIND — harness/product label;
                                          #   describes, never selects policy
    "agent_workspace": "finance-agents",  # agent GROUP — one workspace,
                                          #   one policy set
    "agent_owner":     "payments-team",   # WHO is responsible for this agent
    "agent_user":      "u-8232",          # who is USING it this session
}


def evaluate(kind: str, step_id: str, payload: dict) -> dict | None:
    """The whole protocol is this one call. Returns the Verdict, or None
    when the runtime could not answer — and this integration FAILS OPEN:
    the caller treats None as allow and the step is recorded as unjudged."""
    try:
        r = requests.post(f"{OGR}/v1/evaluate",
                          headers={"Authorization": f"Bearer {KEY}"},
                          json={"kind": kind, "step_id": step_id,
                                "llm_protocol": "openai.chat",
                                **IDENTITY, "payload": payload},
                          timeout=5)
        return r.json() if r.ok else None
    except requests.RequestException:
        return None


def blocked(verdict: dict | None) -> bool:
    """Fail-open: only an explicit block stops the agent."""
    if verdict is None:
        print("  [ogr] no verdict (runtime unreachable) -> fail OPEN, proceeding unjudged")
        return False
    findings = ", ".join(f["category"] for f in verdict.get("findings", [])) or "-"
    print(f"  [ogr] {verdict['decision']:5s}  event_id={verdict['event_id']}  findings: {findings}")
    return verdict["decision"] == "block"


# ── the agent itself: two toy tools, executed locally ───────────────────

SYSTEM_PROMPT = "You are invoice-bot. Use your tools; be brief."

TOOLS = [
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Read a text file from the working directory.",
        "parameters": {"type": "object",
                       "properties": {"path": {"type": "string"}},
                       "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "calc",
        "description": "Evaluate an arithmetic expression.",
        "parameters": {"type": "object",
                       "properties": {"expression": {"type": "string"}},
                       "required": ["expression"]}}},
]

HERE = os.path.dirname(os.path.abspath(__file__))


def tool_read_file(path: str) -> str:
    full = os.path.realpath(os.path.join(HERE, path))
    if not full.startswith(HERE + os.sep):          # toy sandbox: stay in this dir
        return f"error: refusing to read outside {HERE}"
    with open(full, encoding="utf-8") as f:
        return f.read()


def tool_calc(expression: str) -> str:
    if not set(expression) <= set("0123456789.+-*/() "):
        return "error: arithmetic only"
    return str(eval(expression, {"__builtins__": {}}, {}))


def run_tools(tool_calls: list) -> list:
    """Execute the model's tool calls locally; return the tool messages."""
    results = []
    for call in tool_calls:
        name = call["function"]["name"]
        args = json.loads(call["function"]["arguments"])
        if name == "read_file":
            out = tool_read_file(args["path"])
        elif name == "calc":
            out = tool_calc(args["expression"])
        else:
            out = f"error: unknown tool {name}"
        print(f"  [tool] {name}({json.dumps(args)}) -> {out.splitlines()[0][:60]}")
        results.append({"role": "tool", "tool_call_id": call["id"], "content": out})
    return results


def call_llm(request_body: dict) -> dict:
    """Your existing model call, unchanged (OpenAI-compatible endpoint)."""
    r = requests.post(f"{LLM}/v1/chat/completions",
                      headers={"Authorization": f"Bearer {LLM_KEY}"},
                      json=request_body, timeout=60)
    r.raise_for_status()
    return r.json()


# ── the agent loop ──────────────────────────────────────────────────────

def run(task: str) -> None:
    messages = [{"role": "system", "content": SYSTEM_PROMPT},  # the system
                {"role": "user", "content": task}]             # prompt rides
                                                               # in messages[0]
    step = 0
    while True:
        step += 1
        step_id = uuid.uuid4().hex            # one id, both halves of this call
        request_body = {"model": MODEL, "messages": messages, "tools": TOOLS}
        print(f"\nstep {step}  (step_id={step_id[:12]}…)")

        # ① before the model: judge exactly what you are about to send
        if blocked(evaluate("step/request", step_id, request_body)):
            print("  [agent] request blocked — the model is never called; stopping")
            break

        response_body = call_llm(request_body)          # your existing call,
                                                        # unchanged (OpenAI-
                                                        # compatible endpoint)

        # ② after the model, BEFORE acting: the tool calls are held here,
        #    still refusable
        if blocked(evaluate("step/response", step_id, response_body)):
            print("  [agent] response blocked — tool calls never execute; stopping")
            break

        choice = response_body["choices"][0]
        if not choice["message"].get("tool_calls"):
            print(f"  [agent] final answer: {choice['message']['content']}")
            break                                        # nothing to do — done
        messages.append(choice["message"])
        messages.extend(run_tools(choice["message"]["tool_calls"]))
        # tool results need no evaluate of their own: they are judged inside
        # the next step/request, which carries the full conversation


if __name__ == "__main__":
    run(sys.argv[1] if len(sys.argv) > 1 else
        "Read notes.txt and total the refunds for the three orders.")
