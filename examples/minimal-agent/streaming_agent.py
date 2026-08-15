#!/usr/bin/env python3
"""The minimal OGR integration, streaming variant: hold the tail, judge once.

Same loop as agent.py, but the model call streams (SSE). Per
specification/runtime-api.md § "Streaming: hold the tail, judge once":

  1. print the stream as it arrives, withholding the final TAIL characters;
  2. at stream end, reassemble the whole response and submit it as the
     step's one step/response evaluate;
  3. allow -> release the held tail; block -> drop the tail and cut the
     stream — the response never completes.

Configuration and identity are identical to agent.py (imported from it).
Offline demo against the bundled mocks: ./demo.sh
"""

import json
import uuid

import requests

from agent import IDENTITY, KEY, LLM, LLM_KEY, MODEL, OGR, blocked, evaluate  # noqa: F401

TAIL = 200          # withheld characters; the reference default. tail = ∞
                    # degenerates to buffering the whole stream.


def call_llm_streaming(request_body: dict):
    """Stream the model call, printing everything EXCEPT the held tail.
    Returns (reassembled response body, full text, chars already shown)."""
    r = requests.post(f"{LLM}/v1/chat/completions",
                      headers={"Authorization": f"Bearer {LLM_KEY}"},
                      json={**request_body, "stream": True},
                      stream=True, timeout=60)
    r.raise_for_status()
    text, shown, meta = "", 0, {"id": "chatcmpl-stream", "finish_reason": "stop"}
    for raw in r.iter_lines():
        line = raw.decode("utf-8") if raw else ""
        if not line.startswith("data: ") or line == "data: [DONE]":
            continue
        chunk = json.loads(line[len("data: "):])
        meta["id"] = chunk.get("id", meta["id"])
        choice = chunk["choices"][0]
        meta["finish_reason"] = choice.get("finish_reason") or meta["finish_reason"]
        text += choice["delta"].get("content") or ""
        safe = max(len(text) - TAIL, 0)         # everything but the held tail
        if safe > shown:
            print(text[shown:safe], end="", flush=True)
            shown = safe
    # No single raw body ever existed — reassemble the complete response.
    body = {"id": meta["id"], "object": "chat.completion", "model": request_body["model"],
            "choices": [{"index": 0, "finish_reason": meta["finish_reason"],
                         "message": {"role": "assistant", "content": text}}]}
    return body, text, shown


def run(task: str) -> None:
    step_id = uuid.uuid4().hex                # one id, both halves of this call
    request_body = {"model": MODEL, "tools": [],
                    "messages": [{"role": "user", "content": task}]}
    print(f"\ntask: {task}\nstep  (step_id={step_id[:12]}…)")

    # ① before the model: judge exactly what you are about to send
    if blocked(evaluate("step/request", step_id, request_body)):
        return

    print("  [stream] ", end="", flush=True)
    response_body, text, shown = call_llm_streaming(request_body)

    # ② the stream has ended, the tail is still held: judge the whole
    #    response exactly once
    print("\n  [stream] ended; last "
          f"{len(text) - shown} chars held, evaluating the whole response…")
    if blocked(evaluate("step/response", step_id, response_body)):
        print("  [agent] BLOCK — held tail dropped, stream cut; "
              "the response never completes")
        return
    print("  [agent] allow — releasing the held tail:")
    print("  …" + text[shown:])


if __name__ == "__main__":
    run("Summarize our refund policy in two sentences.")   # allow: tail released
    run("Help me back up my SSH keys offsite.")            # block: stream cut
