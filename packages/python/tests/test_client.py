"""RuntimeClient against a local stdlib HTTP server: endpoint paths, auth,
partial header, error mapping, 207 ingest parsing, enrollment, config,
approvals, and the wire mapping checked structurally against
schema/guard-event.schema.json (no external validator dependency)."""
import base64
import json
import pathlib
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import pytest

HERE = pathlib.Path(__file__).resolve()
CORE_SRC = HERE.parents[1] / "src"
sys.path.insert(0, str(CORE_SRC))

from openguardrails import (  # noqa: E402
    GuardEvent,
    Provenance,
    RateLimitedError,
    RuntimeAPIError,
    RuntimeClient,
    Verdict,
)
from openguardrails.client import event_to_wire, verdict_from_wire  # noqa: E402

SCHEMA_DIR = HERE.parents[3] / "schema"
API_KEY = "ogr_test_key"
VERDICT_WIRE = {
    "ogr_version": "0.6", "event_id": "evt-srv-1", "guard_id": "ga-1",
    "provider": "ogr.runtime", "decision": "block",
    "categories": [{"id": "security.exfiltration", "domain": "security", "score": 0.9}],
    "reasons": ["curl to unlisted host"],
    "x.ogr.session_id": "sess-42",
}


class _Handler(BaseHTTPRequestHandler):
    """Scripted OGR runtime. Records every request on server.requests."""

    def log_message(self, *args):  # keep pytest output clean
        pass

    def _record(self, body):
        self.server.requests.append({
            "method": self.command, "path": self.path,
            "headers": {k.lower(): v for k, v in self.headers.items()},
            "body": body,
        })

    def _reply(self, status, payload):
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        self._record(body)
        if self.headers.get("authorization") != f"Bearer {API_KEY}":
            return self._reply(401, {"error": "unauthorized"})
        path = urlparse(self.path).path
        if path.endswith("/v1/evaluate"):
            # v0.6: no client event_id on the wire — the mock keys off guard_id
            # (the one id a client may still send, as a correlation hint).
            if body.get("guard_id") == "ga-rate":
                return self._reply(429, {"error": "rate_limited", "limit": 10})
            if body.get("guard_id") == "ga-bad":
                return self._reply(400, {"error": "invalid_event",
                                         "details": ["payload: required"]})
            return self._reply(200, dict(VERDICT_WIRE))
        if path.endswith("/v1/ingest"):
            # v0.6: the runtime assigns ids; results pair with the batch BY ORDER.
            results = []
            for i, ev in enumerate(body.get("batch", [])):
                if ev.get("guard_id") == "ga-reject":
                    results.append({"id": None, "status": 400,
                                    "error": "invalid_event"})
                else:
                    results.append({"id": f"evt-srv-{i}", "status": 201})
            return self._reply(207, {"results": results})
        if path.endswith("/v1/enroll"):
            return self._reply(201, {"pep_id": "pep-enrolled",
                                     "key_id": "cafe0123cafe0123"})
        if path.endswith("/v1/heartbeat"):
            return self._reply(200, {"ok": True})
        return self._reply(404, {"error": "not_found"})

    def do_GET(self):
        self._record(None)
        if self.headers.get("authorization") != f"Bearer {API_KEY}":
            return self._reply(401, {"error": "unauthorized"})
        parsed = urlparse(self.path)
        if parsed.path.endswith("/v1/approvals"):
            guard_id = parse_qs(parsed.query).get("guard_id", [""])[0]
            if guard_id == "ga-known":
                return self._reply(200, {"status": "pending"})
            return self._reply(404, {"status": "not_found"})
        return self._reply(404, {"error": "not_found"})


class _LegacyMountHandler(_Handler):
    """A historically deployed runtime: canonical /v1/* paths are route-level
    404s; the API lives only under /api/public/ogr."""

    def _route_level_404(self) -> bool:
        if self.path.startswith("/api/public/ogr/"):
            return False
        length = int(self.headers.get("content-length", 0))
        body = (json.loads(self.rfile.read(length))
                if self.command == "POST" and length else None)
        self._record(body)
        self._reply(404, {"error": "not_found"})  # no "status" key: route 404
        return True

    def do_POST(self):
        if not self._route_level_404():
            super().do_POST()

    def do_GET(self):
        if not self._route_level_404():
            super().do_GET()


def _serve(handler):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    srv.requests = []
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    return srv


@pytest.fixture()
def server():
    srv = _serve(_Handler)
    yield srv
    srv.shutdown()
    srv.server_close()


@pytest.fixture()
def legacy_server():
    srv = _serve(_LegacyMountHandler)
    yield srv
    srv.shutdown()
    srv.server_close()


@pytest.fixture()
def client(server):
    # Base URL carries a deployment prefix on purpose: the client must append
    # canonical /v1/* paths to whatever root it is given.
    return RuntimeClient(
        f"http://127.0.0.1:{server.server_address[1]}/api/public/ogr",
        API_KEY, timeout=5.0)


def make_event(**over):
    kw = dict(
        kind="exec", observation_point="execution",
        subject={"agent_id": "agent-1", "agent_type": "test"},
        payload={"command": "curl evil.example"},
        guard_id="ga-1",
        timestamp="2026-08-11T00:00:00Z", session_id="sess-1",
        sensor={"id": "test-sensor", "class": "in_process", "version": None},
        provenance=[Provenance(source="web", trust="untrusted")],
    )
    kw.update(over)
    return GuardEvent(**kw)


# -- evaluate ---------------------------------------------------------------

def test_evaluate_roundtrip(server, client):
    v = client.evaluate(make_event())
    assert isinstance(v, Verdict)
    assert v.decision == "block"
    assert v.categories[0].id == "security.exfiltration"
    assert v.extensions == {"x.ogr.session_id": "sess-42"}  # passthrough
    req = server.requests[-1]
    assert req["path"] == "/api/public/ogr/v1/evaluate"  # prefix + canonical path
    assert req["headers"]["authorization"] == f"Bearer {API_KEY}"
    assert "ogr-partial" not in req["headers"]
    assert req["body"]["ogr_version"] == "0.6"
    assert "event_id" not in req["body"]  # identity is born at the runtime
    assert v.event_id == "evt-srv-1"      # ...and learned from the verdict
    assert "llm_protocol" not in req["body"]  # empty optionals dropped


def test_evaluate_partial_header(server, client):
    client.evaluate(make_event(), partial=True)
    assert server.requests[-1]["headers"]["ogr-partial"] == "1"


def test_evaluate_rate_limited(client):
    with pytest.raises(RateLimitedError) as exc:
        client.evaluate(make_event(guard_id="ga-rate"))
    assert exc.value.status == 429
    assert exc.value.error == "rate_limited"
    assert exc.value.limit == 10


def test_evaluate_invalid_event(client):
    with pytest.raises(RuntimeAPIError) as exc:
        client.evaluate(make_event(guard_id="ga-bad"))
    assert exc.value.status == 400
    assert exc.value.error == "invalid_event"
    assert exc.value.body["details"] == ["payload: required"]


def test_unauthorized(server):
    bad = RuntimeClient(f"http://127.0.0.1:{server.server_address[1]}",
                        "ogr_wrong", timeout=5.0)
    with pytest.raises(RuntimeAPIError) as exc:
        bad.evaluate(make_event())
    assert exc.value.status == 401
    assert exc.value.error == "unauthorized"
    assert not isinstance(exc.value, RateLimitedError)


def test_env_defaults(server, monkeypatch):
    monkeypatch.setenv("OGR_RUNTIME_URL",
                       f"http://127.0.0.1:{server.server_address[1]}")
    monkeypatch.setenv("OGR_API_KEY", API_KEY)
    v = RuntimeClient().evaluate(make_event())
    assert v.decision == "block"


def test_missing_config_raises(monkeypatch):
    monkeypatch.delenv("OGR_RUNTIME_URL", raising=False)
    monkeypatch.delenv("OGR_API_KEY", raising=False)
    with pytest.raises(ValueError):
        RuntimeClient()


# -- ingest -----------------------------------------------------------------

def test_ingest_parses_207_results(server, client):
    results = client.ingest([make_event(guard_id="ga-a"),
                             make_event(guard_id="ga-reject")])
    # v0.6: ids are runtime-assigned and pair with the batch BY ORDER.
    assert results == [{"id": "evt-srv-0", "status": 201},
                       {"id": None, "status": 400,
                        "error": "invalid_event"}]
    req = server.requests[-1]
    assert req["path"] == "/api/public/ogr/v1/ingest"
    assert all("event_id" not in e for e in req["body"]["batch"])
    assert [e["guard_id"] for e in req["body"]["batch"]] == ["ga-a", "ga-reject"]


def test_ingest_chunks_batches_of_100(server, client):
    events = [make_event(guard_id=f"ga-{i:03d}") for i in range(101)]
    results = client.ingest(events)
    assert len(results) == 101  # concatenated across requests
    ingest_reqs = [r for r in server.requests if r["path"].endswith("/v1/ingest")]
    assert [len(r["body"]["batch"]) for r in ingest_reqs] == [100, 1]


# -- enroll / heartbeat / approvals -----------------------------------------

def test_enroll(server, client):
    cred = client.enroll(b"\x01" * 32, pep_id="my-pep", name="my pep")
    assert cred == {"pep_id": "pep-enrolled", "key_id": "cafe0123cafe0123"}
    body = server.requests[-1]["body"]
    assert body["pep_id"] == "my-pep"
    assert body["name"] == "my pep"
    # raw bytes are b64url-encoded (unpadded) for the wire
    assert base64.urlsafe_b64decode(body["public_key"] + "==") == b"\x01" * 32


def test_heartbeat(server, client):
    assert client.heartbeat(sensor={"id": "test-sensor"}, interval_s=30,
                            counters={"events": 5}) == {"ok": True}
    body = server.requests[-1]["body"]
    assert body == {"sensor": {"id": "test-sensor"}, "interval_s": 30,
                    "counters": {"events": 5}}


def test_get_approval_pending_and_not_found(client):
    assert client.get_approval("ga-known") == {"status": "pending"}
    # the 404 body IS the answer — pollers branch on status, not exceptions
    assert client.get_approval("ga-unknown") == {"status": "not_found"}


# -- legacy mount fallback --------------------------------------------------

def test_legacy_mount_fallback_discovers_and_caches(legacy_server):
    c = RuntimeClient(f"http://127.0.0.1:{legacy_server.server_address[1]}",
                      API_KEY, timeout=5.0)
    v = c.evaluate(make_event())
    assert v.decision == "block"
    assert [r["path"] for r in legacy_server.requests] == [
        "/v1/evaluate",                     # canonical probe, route-level 404
        "/api/public/ogr/v1/evaluate",      # one retry on the legacy mount
    ]
    c.evaluate(make_event())                # mount cached: no second probe
    assert [r["path"] for r in legacy_server.requests[2:]] == [
        "/api/public/ogr/v1/evaluate"]


def test_legacy_mount_fallback_covers_get_and_approvals(legacy_server):
    c = RuntimeClient(f"http://127.0.0.1:{legacy_server.server_address[1]}",
                      API_KEY, timeout=5.0)
    # approvals semantics survive the legacy mount
    assert c.get_approval("ga-known") == {"status": "pending"}
    assert c.get_approval("ga-unknown") == {"status": "not_found"}


def test_legacy_mount_fallback_before_discovery_keeps_approvals_semantics(
        legacy_server):
    # First request ever is an approvals poll: canonical 404s at route level,
    # the legacy retry answers with the semantic 404 body — which is returned,
    # not swallowed and not re-retried.
    c = RuntimeClient(f"http://127.0.0.1:{legacy_server.server_address[1]}",
                      API_KEY, timeout=5.0)
    assert c.get_approval("ga-unknown") == {"status": "not_found"}
    assert [r["path"].split("?")[0] for r in legacy_server.requests] == [
        "/v1/approvals", "/api/public/ogr/v1/approvals"]


def test_approvals_semantic_404_is_never_a_mount_probe(server):
    # A modern runtime serving canonical paths: the approvals 404 body IS the
    # answer — exactly one request, no /api/public/ogr fallback attempt.
    c = RuntimeClient(f"http://127.0.0.1:{server.server_address[1]}",
                      API_KEY, timeout=5.0)
    assert c.get_approval("ga-unknown") == {"status": "not_found"}
    assert len(server.requests) == 1
    assert server.requests[0]["path"].startswith("/v1/approvals")


def test_no_fallback_when_base_url_already_carries_the_legacy_mount(
        legacy_server):
    # base_url ends in /api/public/ogr: a 404 there is final (never a second
    # insert of the prefix).
    c = RuntimeClient(
        f"http://127.0.0.1:{legacy_server.server_address[1]}"
        "/wrong/api/public/ogr", API_KEY, timeout=5.0)
    with pytest.raises(RuntimeAPIError) as exc:
        c.get_approval("ga-known")
    assert exc.value.status == 404
    assert len(legacy_server.requests) == 1


# -- wire mapping vs schema -------------------------------------------------

def test_event_to_wire_matches_schema_structure():
    schema = json.loads((SCHEMA_DIR / "guard-event.schema.json").read_text())
    wire = event_to_wire(make_event())

    assert set(schema["required"]) <= set(wire)          # all required present
    assert set(wire) <= set(schema["properties"])         # additionalProperties: false
    assert wire["ogr_version"] == schema["properties"]["ogr_version"]["const"]

    def no_empties(x):
        if isinstance(x, dict):
            return all(v is not None and v != [] and v != "" and no_empties(v)
                       for v in x.values())
        if isinstance(x, list):
            return all(no_empties(v) for v in x)
        return True
    assert no_empties(wire)  # empty optionals never reach the wire

    # nested objects are cleaned too (schema forbids nulls in them)
    assert wire["sensor"] == {"id": "test-sensor", "class": "in_process"}
    prov_props = schema["properties"]["provenance"]["items"]["properties"]
    for p in wire["provenance"]:
        assert set(p) <= set(prov_props)
        assert {"source", "trust"} <= set(p)


def test_event_to_wire_passes_dicts_through_with_extensions():
    wire = event_to_wire({"event_id": "evt-1", "run_id": "run-9", "turn": 0,
                          "authz": {"transcript": "t"}, "llm_protocol": None})
    assert "event_id" not in wire          # v0.6: stripped even from dict input
    assert wire["run_id"] == "run-9"       # runtime extension fields survive
    assert wire["turn"] == 0               # falsy-but-meaningful kept
    assert wire["authz"] == {"transcript": "t"}
    assert "llm_protocol" not in wire


def test_verdict_wire_roundtrip():
    v = verdict_from_wire(VERDICT_WIRE)
    assert v.extensions == {"x.ogr.session_id": "sess-42"}
    d = v.to_dict()
    assert "extensions" not in d           # extensions stay off the wire type
    assert d["decision"] == "block"
    assert d["categories"][0] == {"id": "security.exfiltration",
                                  "domain": "security", "score": 0.9}


# -- signing ----------------------------------------------------------------

def test_ed25519_signer_detached_jws(server):
    pytest.importorskip("cryptography")
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    from openguardrails import Ed25519Signer

    signer = Ed25519Signer()
    assert signer.signature_header(b"{}") is None  # unenrolled → unsigned

    client = RuntimeClient(f"http://127.0.0.1:{server.server_address[1]}",
                           API_KEY, timeout=5.0, signer=signer)
    cred = client.enroll(signer.public_key_b64url(), name="test pep")
    signer.key_id = cred["key_id"]
    client.evaluate(make_event())

    req = server.requests[-1]
    value = req["headers"]["ogr-batch-signature"]
    header_b64, empty, sig_b64 = value.split(".")
    assert empty == ""                      # detached: ".." between parts
    header = json.loads(base64.urlsafe_b64decode(header_b64 + "=="))
    assert header == {"alg": "EdDSA", "kid": "cafe0123cafe0123",
                      "b64": False, "crit": ["b64"]}

    # signature verifies over ascii(b64url(header)) || "." || raw_body
    body = json.dumps(event_to_wire(make_event())).encode("utf-8")
    public = Ed25519PublicKey.from_public_bytes(
        base64.urlsafe_b64decode(signer.public_key_b64url() + "=="))
    public.verify(base64.urlsafe_b64decode(sig_b64 + "=="),
                  header_b64.encode("ascii") + b"." + body)

    # round-trips through the seed for caller-owned persistence
    clone = Ed25519Signer(signer.private_key_b64url(), key_id=signer.key_id)
    assert clone.public_key_b64url() == signer.public_key_b64url()


# -- batching ingestor ------------------------------------------------------

def test_batching_ingestor_flush(server, client):
    from openguardrails import BatchingIngestor
    ing = BatchingIngestor(client, flush_seconds=60.0)  # worker parked; flush drives
    ing.submit(make_event(guard_id="ga-q1"))
    ing.submit(make_event(guard_id="ga-q2"))
    assert ing.flush() == 2
    ingest_reqs = [r for r in server.requests if r["path"].endswith("/v1/ingest")]
    sent = [e["guard_id"] for r in ingest_reqs for e in r["body"]["batch"]]
    assert sent == ["ga-q1", "ga-q2"]
    assert ing.flush() == 0  # queue drained
