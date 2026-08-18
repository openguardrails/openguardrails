"""OpenGuardrails for litellm — the v0.8 recipe on litellm's hook surface.

litellm normalizes every provider to the OpenAI chat shape, so every event
this integration sends is ``llm_protocol: "openai.chat"`` (or ``canonical``
for a reassembled stream no single raw body ever existed for), and the
payloads are what litellm actually holds: the request kwargs it is about to
send, the ModelResponse it got back — forwarded raw, minus litellm's own
bookkeeping and credentials, which are not part of any provider body.

One class, both litellm seats:

PROXY (enforcing — the recipe's two refusable moments):
  - ``async_pre_call_hook``       → step/request; raising blocks the call
  - ``async_post_call_success_hook`` → step/response; raising blocks the reply
  - ``async_post_call_streaming_iterator_hook`` → buffers the stream, judges
    it ONCE, whole, at stream end (v0.8 tail-hold with tail = ∞ — the only
    tail this seat can hold, see README), then releases or aborts

SDK (``litellm.callbacks = [OpenGuardrails()]`` — observe-only):
  - ``log_pre_api_call`` / ``async_log_pre_api_call``     → step/request
  - ``log_success_event`` / ``async_log_success_event``   → step/response
  litellm swallows logging-callback exceptions, so this seat records verdicts
  (and counts blocks) but CANNOT stop the call. Stated plainly in the README.

``step_id`` is litellm's own ``litellm_call_id`` — the proxy mints it into the
request ``data`` before ``async_pre_call_hook`` runs, and the same id reaches
every later hook (post-success, streaming iterator, logging events via
``litellm_params``), which is exactly the one-id-per-call the wire needs.
When it is missing (direct unit use, exotic versions) we mint one and stash it
in the request ``metadata`` dict litellm carries through to the other half.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timezone

from .spans import apply_spans, write_path
from .wire import INTEGRATION, Wire

logger = logging.getLogger("openguardrails")

try:  # the real base class when litellm is installed …
    from litellm.integrations.custom_logger import CustomLogger
except ImportError:  # … a stand-in so the module stays importable without it
    class CustomLogger:  # type: ignore[no-redef]
        def __init__(self, **kwargs):
            pass


try:  # inside the proxy, FastAPI is always present and an HTTPException
    # becomes a clean 400 to the caller instead of a 500
    from fastapi import HTTPException as _HTTPException

    class OpenGuardrailsBlockedError(_HTTPException):
        """Raised to refuse a step. In the proxy this surfaces as HTTP 400
        ``blocked_by_openguardrails``; the model is never called (request
        half) or the response never reaches the client (response half)."""

        def __init__(self, message: str, verdict: "dict | None" = None):
            self.message = message
            self.verdict = verdict
            super().__init__(
                status_code=400,
                detail={
                    "error": "blocked_by_openguardrails",
                    "message": message,
                    "findings": (verdict or {}).get("findings", []),
                },
            )

except ImportError:

    class OpenGuardrailsBlockedError(Exception):  # type: ignore[no-redef]
        """Raised to refuse a step (plain-Exception form when FastAPI is
        not installed)."""

        def __init__(self, message: str, verdict: "dict | None" = None):
            self.message = message
            self.verdict = verdict
            super().__init__(message)


# litellm bookkeeping and credentials that ride in the proxy's request dict
# but are NOT part of the provider body the runtime judges. Everything else
# is forwarded raw.
_NON_PROVIDER_KEYS = frozenset({
    "litellm_call_id",
    "litellm_logging_obj",
    "litellm_metadata",
    "litellm_trace_id",
    "metadata",
    "proxy_server_request",
    "secret_fields",
    "user_api_key_dict",
})
_CREDENTIAL_KEYS = frozenset({
    "api_key",
    "azure_ad_token",
    "aws_secret_access_key",
    "authorization",
    "extra_headers",
})

#: call types this integration judges — the OpenAI chat plane litellm
#: normalizes to. Embeddings, image generation etc. pass through unjudged.
_JUDGED_CALL_TYPES = frozenset({"completion", "acompletion"})

_LRU_CAP = 4096


def _now() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _iso(value) -> "str | None":
    """Wall clocks as litellm hands them over: datetime, epoch float, or str."""
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return (
            value.astimezone(timezone.utc)
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
    if isinstance(value, (int, float)):
        return _iso(datetime.fromtimestamp(value, timezone.utc))
    if isinstance(value, str) and value:
        return value
    return None


class OpenGuardrails(CustomLogger):
    """The litellm hook class. Register it once; it enforces where litellm
    lets it (proxy) and observes where litellm does not (SDK callbacks)."""

    def __init__(
        self,
        runtime_url: "str | None" = None,
        api_key: "str | None" = None,
        agent_id: "str | None" = None,
        agent_type: "str | None" = None,
        agent_workspace: "str | None" = None,
        agent_user: "str | None" = None,
        fail_mode: "str | None" = None,
        timeout: "float | None" = None,
    ):
        try:
            super().__init__()
        except TypeError:  # unknown CustomLogger vintage
            pass

        def env(value, name, default=""):
            return value if value is not None else os.environ.get(name, default)

        # The identity four-tuple: all four always on the wire, "" = the
        # explicit "no assertion" (the runtime then derives from the API key).
        self.identity = {
            "agent_id": env(agent_id, "OGR_AGENT_ID"),
            "agent_type": env(agent_type, "OGR_AGENT_TYPE", "litellm"),
            "agent_workspace": env(agent_workspace, "OGR_AGENT_WORKSPACE"),
            "agent_user": env(agent_user, "OGR_AGENT_USER"),
        }
        self.fail_mode = env(fail_mode, "OGR_FAIL_MODE", "open").lower()
        if self.fail_mode not in ("open", "closed"):
            raise ValueError("fail_mode must be 'open' or 'closed'")
        self.wire = Wire(
            runtime_url=env(runtime_url, "OGR_RUNTIME_URL"),
            api_key=env(api_key, "OGR_API_KEY"),
            timeout=float(env(timeout, "OGR_TIMEOUT", 5.0)),
        )
        # Degraded-mode spec: entering/leaving degraded SHOULD be loud, and
        # the heartbeat's counters are how the runtime sees a fail-open gap.
        self.counters = {
            "events_sent": 0,
            "evaluate_errors": 0,
            "blocks": 0,
            "unresolved_spans": 0,
        }
        self._lock = threading.Lock()
        self._proxy_steps: "OrderedDict[str, bool]" = OrderedDict()  # dedup
        self._started_at: "OrderedDict[str, str]" = OrderedDict()  # timing
        self._warned_off = False

    # ── config / plumbing ────────────────────────────────────────────────

    @property
    def enabled(self) -> bool:
        """No runtime URL or no API key = the integration is off (and says
        so once). fail_mode governs a runtime that stopped ANSWERING, not a
        runtime that was never configured."""
        return self.wire.configured

    def _off(self) -> bool:
        if self.enabled:
            return False
        if not self._warned_off:
            self._warned_off = True
            logger.warning(
                "openguardrails: no runtime configured "
                "(OGR_RUNTIME_URL / OGR_API_KEY) — integration is off"
            )
        return True

    def _bump(self, counter: str, by: int = 1) -> None:
        with self._lock:
            self.counters[counter] += by

    def _remember(self, store: OrderedDict, key: str, value) -> None:
        with self._lock:
            store[key] = value
            while len(store) > _LRU_CAP:
                store.popitem(last=False)

    def _event(self, kind: str, step_id: str, payload: dict,
               llm_protocol: str = "openai.chat") -> dict:
        """One v0.8 GuardEvent: nine fields, all required, nothing else."""
        event = {"kind": kind, "step_id": step_id}
        event.update(self.identity)
        event["llm_protocol"] = llm_protocol
        event["payload"] = payload
        return event

    def _evaluate(self, event: dict) -> "dict | None":
        verdict = self.wire.evaluate(event)
        self._bump("events_sent")
        if verdict is None:
            self._bump("evaluate_errors")
        return verdict

    async def _evaluate_async(self, event: dict) -> "dict | None":
        # urllib is blocking; keep the proxy's event loop out of it.
        return await asyncio.to_thread(self._evaluate, event)

    def _enforce(self, verdict: "dict | None", kind: str, step_id: str) -> None:
        """Turn a verdict (or its absence) into the local decision. Raising
        is the refusal; returning means proceed (spans may still apply)."""
        if verdict is None:
            if self.fail_mode == "closed":
                self._bump("blocks")
                raise OpenGuardrailsBlockedError(
                    f"openguardrails: no verdict for {kind} (step {step_id}) "
                    "and fail_mode=closed — denied while the runtime is dark"
                )
            logger.warning(
                "openguardrails: %s (step %s) went unjudged — "
                "runtime unreachable, failing open", kind, step_id,
            )
            return
        if verdict.get("decision") == "block":
            self._bump("blocks")
            categories = ", ".join(
                f.get("category", "?") for f in verdict.get("findings", [])
            ) or "no findings attached"
            raise OpenGuardrailsBlockedError(
                f"openguardrails: {kind} blocked (step {step_id}): {categories}",
                verdict=verdict,
            )
        # "Could not look" is not "found nothing": under fail-closed a
        # non-empty unjudged is the same outage at a smaller size.
        if self.fail_mode == "closed" and verdict.get("unjudged"):
            self._bump("blocks")
            raise OpenGuardrailsBlockedError(
                f"openguardrails: {kind} (step {step_id}) left "
                f"{verdict['unjudged']} unjudged and fail_mode=closed",
                verdict=verdict,
            )

    # ── step_id: litellm_call_id, or a minted id stashed in metadata ─────

    def _step_id(self, data: dict) -> str:
        call_id = data.get("litellm_call_id") if isinstance(data, dict) else None
        if not call_id and isinstance(data, dict):
            metadata = data.get("metadata") or {}
            call_id = metadata.get("ogr_step_id") or (
                data.get("litellm_params") or {}
            ).get("litellm_call_id")
        if not call_id:
            call_id = uuid.uuid4().hex
            if isinstance(data, dict):
                data.setdefault("metadata", {})["ogr_step_id"] = call_id
        return str(call_id)

    def _sdk_step_id(self, kwargs: dict) -> str:
        litellm_params = kwargs.get("litellm_params") or {}
        metadata = litellm_params.get("metadata") or {}
        return str(
            kwargs.get("litellm_call_id")
            or litellm_params.get("litellm_call_id")
            or metadata.get("ogr_step_id")
            or uuid.uuid4().hex
        )

    # ── payload projection: forward raw, strip bookkeeping and secrets ───

    @staticmethod
    def _strip(body: dict) -> dict:
        return {
            k: v
            for k, v in body.items()
            if k not in _NON_PROVIDER_KEYS and k not in _CREDENTIAL_KEYS
        }

    @staticmethod
    def _response_payload(response) -> dict:
        """The ModelResponse as a plain dict, forwarded raw. pydantic v2,
        v1, dicts, then a stringify fallback, in that order."""
        for attr in ("model_dump", "dict"):
            method = getattr(response, attr, None)
            if callable(method):
                try:
                    dumped = method()
                    if isinstance(dumped, dict):
                        return dumped
                except Exception:
                    pass
        if isinstance(response, dict):
            return response
        try:
            return json.loads(json.dumps(response, default=str))
        except Exception:
            return {"raw": str(response)}

    def _with_timing(self, payload: dict, started_at: "str | None",
                     first_token_at: "str | None" = None,
                     completed_at: "str | None" = None) -> dict:
        """step/response SHOULD carry timing — but a body that already has a
        top-level `timing` keeps it (the spec says leave it alone)."""
        payload = dict(payload)
        if "timing" not in payload:
            timing = {
                "started_at": started_at or completed_at or _now(),
                "completed_at": completed_at or _now(),
            }
            if first_token_at:
                timing["first_token_at"] = first_token_at
            payload["timing"] = timing
        return payload

    # ═════════════════════════════ PROXY seat ════════════════════════════

    async def async_pre_call_hook(self, user_api_key_dict, cache, data: dict,
                                  call_type: str):
        """step/request — litellm is holding what it is about to send, and a
        raise here means the model is never called."""
        if call_type not in _JUDGED_CALL_TYPES or self._off():
            return data
        step_id = self._step_id(data)
        self._remember(self._proxy_steps, step_id, True)  # claim from SDK logs
        started_at = _now()
        self._remember(self._started_at, step_id, started_at)
        verdict = await self._evaluate_async(
            self._event("step/request", step_id, self._strip(data))
        )
        self._enforce(verdict, "step/request", step_id)
        if verdict and (verdict.get("modifications") or {}).get("spans"):
            # The payload was a shallow projection of `data`: same nested
            # message objects, same offsets — apply straight to `data` so
            # the redacted form is what litellm sends upstream.
            _, unresolved, _ = apply_spans(
                data, verdict["modifications"]["spans"]
            )
            if unresolved:
                self._bump("unresolved_spans", unresolved)
        return data

    async def async_post_call_success_hook(self, data: dict,
                                           user_api_key_dict, response):
        """step/response — the reply is held before it returns to the client;
        its tool calls have not run. A raise refuses the whole step."""
        if self._off():
            return response
        step_id = self._step_id(data if isinstance(data, dict) else {})
        with self._lock:
            claimed = step_id in self._proxy_steps
            started_at = self._started_at.pop(step_id, None)
        payload = self._response_payload(response)
        if not claimed and "choices" not in payload:
            return response  # not a chat completion this integration judged
        payload = self._with_timing(payload, started_at, completed_at=_now())
        verdict = await self._evaluate_async(
            self._event("step/response", step_id, payload)
        )
        self._enforce(verdict, "step/response", step_id)
        if verdict and (verdict.get("modifications") or {}).get("spans"):
            _, unresolved, changed = apply_spans(
                payload, verdict["modifications"]["spans"]
            )
            # Mirror each rewritten string into the LIVE response object —
            # the dict we judged was a dump, not the thing litellm returns.
            for path, value in changed.items():
                if not write_path(response, path, value):
                    unresolved += 1
            if unresolved:
                self._bump("unresolved_spans", unresolved)
        return response

    async def async_post_call_streaming_iterator_hook(self, user_api_key_dict,
                                                      response,
                                                      request_data: dict):
        """A streamed step, judged EXACTLY ONCE, whole, at stream end.

        litellm's iterator hook wraps the whole stream, so from this seat the
        v0.8 tail-hold degenerates to tail = ∞: buffer every chunk, evaluate
        the reassembled response, then release the buffer on allow or abort
        the stream on block (no chunk ever reached the client early, and no
        tool call runs — a provider stream only completes them at its end).
        Chunk-by-chunk evaluates are deliberately NOT a thing (v0.8 removed
        them); the cost is time-to-first-token for streaming clients.
        """
        if self._off():
            async for chunk in response:
                yield chunk
            return
        step_id = self._step_id(request_data if isinstance(request_data, dict) else {})
        with self._lock:
            started_at = self._started_at.pop(step_id, None)
        first_token_at = None
        chunks = []
        async for chunk in response:
            if first_token_at is None:
                first_token_at = _now()
            chunks.append(chunk)
        completed_at = _now()
        llm_protocol, payload = self._assemble_stream(chunks)
        payload = self._with_timing(payload, started_at, first_token_at,
                                    completed_at)
        verdict = await self._evaluate_async(
            self._event("step/response", step_id, payload, llm_protocol)
        )
        self._enforce(verdict, "step/response", step_id)  # block = held tail dropped
        for chunk in chunks:
            yield chunk

    def _assemble_stream(self, chunks) -> "tuple[str, dict]":
        """Reassemble the whole response: litellm's own builder when it can
        (a raw ``openai.chat`` body), else the canonical shape — the spec's
        home for a stream no single raw body ever existed for."""
        try:
            import litellm  # noqa: PLC0415 — resolved at call time on purpose

            builder = getattr(litellm, "stream_chunk_builder", None)
            if callable(builder):
                rebuilt = builder(list(chunks))
                if rebuilt is not None:
                    payload = self._response_payload(rebuilt)
                    if "choices" in payload:
                        return "openai.chat", payload
        except Exception as err:
            logger.warning(
                "openguardrails: stream_chunk_builder failed (%s) — "
                "falling back to the canonical shape", err,
            )
        return "canonical", self._canonical_from_chunks(chunks)

    def _canonical_from_chunks(self, chunks) -> dict:
        text = ""
        model = ""
        tool_calls: "OrderedDict[int, dict]" = OrderedDict()
        for chunk in chunks:
            body = self._response_payload(chunk)
            model = body.get("model") or model
            for choice in body.get("choices") or []:
                delta = choice.get("delta") or {}
                text += delta.get("content") or ""
                for fragment in delta.get("tool_calls") or []:
                    slot = tool_calls.setdefault(
                        fragment.get("index", 0),
                        {"id": "", "name": "", "arguments": ""},
                    )
                    if fragment.get("id"):
                        slot["id"] = fragment["id"]
                    function = fragment.get("function") or {}
                    if function.get("name"):
                        slot["name"] = function["name"]
                    slot["arguments"] += function.get("arguments") or ""
        calls = []
        for slot in tool_calls.values():
            try:  # canonical carries parsed arguments when they parse
                slot["arguments"] = json.loads(slot["arguments"])
            except (ValueError, TypeError):
                pass
            calls.append(slot)
        payload = {"text": text, "model": model}
        if calls:
            payload["tool_calls"] = calls
        # No usage key: the spec says omit it rather than report zeros —
        # an integration holds no tokenizer, and absence is the honest value.
        return payload

    # ═════════════════════════════ SDK seat ══════════════════════════════
    # litellm.callbacks = [OpenGuardrails()] fires LOGGING events, whose
    # exceptions litellm swallows — so this seat observes and counts, and
    # cannot block. The proxy hooks above claim their step_ids first, so a
    # proxy deployment never double-sends through these.

    def log_pre_api_call(self, model, messages, kwargs):
        self._sdk_request_event(model, messages, kwargs)

    async def async_log_pre_api_call(self, model, messages, kwargs):
        await asyncio.to_thread(self._sdk_request_event, model, messages, kwargs)

    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        self._sdk_response_event(kwargs, response_obj, start_time, end_time)

    async def async_log_success_event(self, kwargs, response_obj, start_time,
                                      end_time):
        await asyncio.to_thread(
            self._sdk_response_event, kwargs, response_obj, start_time, end_time
        )

    def _sdk_claimed(self, step_id: str) -> bool:
        with self._lock:
            return step_id in self._proxy_steps

    def _sdk_judged_type(self, kwargs: dict) -> bool:
        call_type = str(kwargs.get("call_type") or "completion")
        return call_type in _JUDGED_CALL_TYPES

    def _sdk_request_event(self, model, messages, kwargs) -> None:
        if self._off() or not isinstance(kwargs, dict):
            return
        if not self._sdk_judged_type(kwargs):
            return
        step_id = self._sdk_step_id(kwargs)
        if self._sdk_claimed(step_id):
            return  # the proxy seat already judged this half
        self._remember(self._started_at, step_id, _now())
        payload = (kwargs.get("additional_args") or {}).get("complete_input_dict")
        if not isinstance(payload, dict):
            payload = {"model": model, "messages": messages}
        verdict = self._evaluate(
            self._event("step/request", step_id, self._strip(payload))
        )
        self._sdk_observe(verdict, "step/request", step_id)

    def _sdk_response_event(self, kwargs, response_obj, start_time, end_time) -> None:
        if self._off() or not isinstance(kwargs, dict):
            return
        if not self._sdk_judged_type(kwargs):
            return
        step_id = self._sdk_step_id(kwargs)
        if self._sdk_claimed(step_id):
            return
        with self._lock:
            self._started_at.pop(step_id, None)
        # A streamed SDK call logs success once, at stream end, with the
        # complete response litellm itself assembled.
        complete = kwargs.get("complete_streaming_response") or kwargs.get(
            "async_complete_streaming_response"
        )
        payload = self._response_payload(complete or response_obj)
        payload = self._with_timing(
            payload,
            _iso(start_time),
            _iso(kwargs.get("completion_start_time")),
            _iso(end_time) or _now(),
        )
        verdict = self._evaluate(self._event("step/response", step_id, payload))
        self._sdk_observe(verdict, "step/response", step_id)

    def _sdk_observe(self, verdict: "dict | None", kind: str, step_id: str) -> None:
        """The SDK seat's honest ceiling: record what enforcement would have
        done, loudly, because litellm swallows anything raised from here."""
        try:
            self._enforce(verdict, kind, step_id)
        except OpenGuardrailsBlockedError as err:
            logger.error(
                "openguardrails: %s — SDK callbacks cannot enforce; "
                "the call proceeds (use the proxy hooks to block)",
                getattr(err, "message", err),
            )

    # ── heartbeat ────────────────────────────────────────────────────────

    def send_heartbeat(self, interval_s: "int | None" = None) -> bool:
        """POST /v1/heartbeat: liveness, the build id, and the counters that
        keep a fail-open gap visible. Optional; call it on a timer if you
        want fleet coverage to distinguish idle from dark."""
        if self._off():
            return False
        body = {"integration": INTEGRATION}
        if self.identity["agent_id"]:
            body["agent_id"] = self.identity["agent_id"]
        if interval_s is not None:
            body["interval_s"] = interval_s
        with self._lock:
            body["counters"] = dict(self.counters)
        return self.wire.heartbeat(body)
