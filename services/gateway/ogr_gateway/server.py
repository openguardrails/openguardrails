"""Reference gateway server — stdlib only, zero dependencies beyond the core.

    python3 -m ogr_gateway.server            # starts on :8800
    ogr-gateway --port 8800                   # console-script entry point

It accepts OpenAI and Anthropic requests, enforces the OGR policy at the gateway
altitude, and forwards allowed requests upstream. With no upstream configured it
returns a deterministic stub completion so the whole path runs offline.

Env:
    OGR_GATEWAY_POLICY   path to policy.json (default: bundled)
    OGR_UPSTREAM_BASE    e.g. https://api.openai.com — if set, requests are proxied
    OGR_UPSTREAM_KEY     bearer token forwarded as Authorization on proxy
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import protocols
from .engine import GatewayEngine

ENGINE = GatewayEngine()


def _forward_or_stub(proto, norm: dict, decision, raw_body: dict, path: str):
    """Allowed (or redacted) request → upstream. Returns a base.Response."""
    note = _stub_note(decision)
    base = os.environ.get("OGR_UPSTREAM_BASE")
    if not base:
        return proto.stub_completion(norm, note)

    # Real proxy: forward the (possibly redacted) body upstream.
    body = _redact_body(raw_body, decision.redactions) if decision.redactions else raw_body
    req = urllib.request.Request(
        base.rstrip("/") + path, method="POST",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json",
                 **({"authorization": f"Bearer {os.environ['OGR_UPSTREAM_KEY']}"}
                    if os.environ.get("OGR_UPSTREAM_KEY") else {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 (operator-configured)
            return r.status, json.loads(r.read() or b"{}"), {"x-ogr-upstream": base}
    except urllib.error.HTTPError as e:  # surface upstream errors verbatim
        return e.code, json.loads(e.read() or b"{}"), {"x-ogr-upstream": base}


def _stub_note(decision) -> str:
    if decision.redactions:
        labels = ", ".join(sorted({r["label"] for r in decision.redactions}))
        return (f"[OGR stub] allowed after redacting {len(decision.redactions)} secret(s) "
                f"({labels}). Configure OGR_UPSTREAM_BASE to proxy a real model.")
    return "[OGR stub] allowed by policy. Configure OGR_UPSTREAM_BASE to proxy a real model."


def _redact_body(body: dict, redactions: list[dict]) -> dict:
    raw = json.dumps(body)
    for r in redactions:
        raw = raw.replace(r["match"], f"[REDACTED:{r['label']}]")
    return json.loads(raw)


class Handler(BaseHTTPRequestHandler):
    server_version = "OGRGateway/0.1"

    # -- plumbing -------------------------------------------------------
    def _send(self, status: int, body: dict, headers: dict | None = None):
        payload = json.dumps(body, indent=2).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        for k, v in (headers or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt, *args):  # quieter default logging
        sys.stderr.write("ogr-gateway: " + (fmt % args) + "\n")

    # -- routes ---------------------------------------------------------
    def do_GET(self):
        if self.path in ("/healthz", "/health"):
            return self._send(200, {"status": "ok"})
        if self.path == "/policy":
            return self._send(200, {
                "detectors": [d.provider for d in ENGINE.detectors],
                "composition": ENGINE.policy.get("composition", {}),
                "content_rules": ENGINE.policy.get("content_rules", {}),
            })
        return self._send(200, {
            "service": "openguardrails-gateway",
            "altitude": "gateway",
            "routes": protocols.all_paths(),
            "detectors": [d.provider for d in ENGINE.detectors],
            "docs": "https://openguardrails.com/docs/integrations/",
        })

    def do_POST(self):
        proto = protocols.for_path(self.path)
        if proto is None:
            return self._send(404, {"error": {"message": f"no protocol bound to {self.path}",
                                              "type": "not_found"}})
        try:
            length = int(self.headers.get("content-length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, TypeError):
            return self._send(400, {"error": {"message": "invalid JSON body",
                                              "type": "bad_request"}})

        norm = proto.parse(body)
        decision = ENGINE.inspect_request(norm)

        if decision.decision == "block":
            return self._send(*proto.block_response(decision))
        if decision.decision == "require_approval":
            return self._send(*proto.approval_response(decision))

        # allow / redact / modify → forward (stub or real upstream)
        status, resp_body, headers = _forward_or_stub(proto, norm, decision, body, self.path)
        headers = {**headers, "x-ogr-decision": decision.decision,
                   "x-ogr-guard-id": decision.guard_id}
        if decision.redactions:
            headers["x-ogr-redactions"] = str(len(decision.redactions))
        return self._send(status, resp_body, headers)


def serve(host: str = "127.0.0.1", port: int = 8800):
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"openguardrails-gateway on http://{host}:{port}  routes={protocols.all_paths()}")
    print(f"  detectors: {[d.provider for d in ENGINE.detectors]}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


def main(argv: list[str] | None = None):
    ap = argparse.ArgumentParser(prog="ogr-gateway", description="OpenGuardrails reference gateway")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8800)
    args = ap.parse_args(argv)
    serve(args.host, args.port)


if __name__ == "__main__":
    main()
