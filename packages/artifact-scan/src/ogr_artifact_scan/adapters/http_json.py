"""The OGR Artifact Scan contract itself — `POST /v1/analyze`.

`malware0` is the reference implementation; `http_generic` is the same shape at a
customer's own URL. That IS the whole difference between the two provider names
today, and saying so is more honest than an abstraction that pretends otherwise.

⚠️ **HASH FIRST, THEN ONLY THE RANGES THE SERVER ASKS FOR.** This is what lets a
300 MB sample be answered without a 300 MB upload, and it is part of the contract
rather than a private optimisation (`specification/artifact-scan.md`).
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request

from ..artifact import Artifact
from ..result import ScanResult, failed
from .base import AdapterError

#: ⚠️ BOUNDED. The server drives the loop, so an unbounded one is a server that
#: can keep this client uploading forever.
MAX_ROUNDS = 3


class HttpJsonAdapter:
    name = "malware0"

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        name: str = "malware0",
        model: str = "",
        timeout_s: float = 30.0,
        max_upload_bytes: int = 256 << 20,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.name = name
        self.model = model
        self.timeout_s = timeout_s
        self.max_upload_bytes = max_upload_bytes

    # ── the wire ──────────────────────────────────────────────────────────
    def _post(self, path: str, body: dict) -> tuple[int, dict]:
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=json.dumps(body).encode(),
            headers={
                "content-type": "application/json",
                "authorization": f"Bearer {self.api_key}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as res:
                raw = res.read()
                status = res.status
        except urllib.error.HTTPError as exc:  # a status IS an answer
            status, raw = exc.code, exc.read()
        except Exception as exc:  # noqa: BLE001 — transport, any cause
            raise AdapterError(str(exc)) from exc
        try:
            return status, json.loads(raw or b"{}")
        except ValueError:
            # ⚠️ An unparseable body is a FAILURE, never a pass. An HTML error
            # page from something in front of the scanner parses as nothing and
            # would otherwise read as "no findings".
            raise AdapterError(f"http {status}: unparseable body") from None

    def _source(self, artifact: Artifact) -> dict:
        if artifact.kind == "file":
            src = {
                "sha256": artifact.sha256,
                "size": artifact.size,
                "declared_type": artifact.declared_type,
            }
            if artifact.head:
                src["head_b64"] = base64.b64encode(artifact.head).decode()
            return src
        # ⚠️ A package spec MUST carry its ecosystem (`npm:left-pad@9.9.9`):
        # `left-pad` names different things on npm and PyPI, and a reputation
        # answer about the wrong registry is worse than no answer.
        return {artifact.kind: artifact.locator}

    def scan(self, artifact: Artifact) -> ScanResult:
        body: dict = {"kind": artifact.kind, "source": self._source(artifact)}
        if self.model:
            body["model"] = self.model
        uploaded = 0

        for _ in range(MAX_ROUNDS):
            status, payload = self._post("/v1/analyze", body)

            if status == 206 and payload.get("status") == "need_ranges":
                ranges = payload.get("ranges") or []
                if not ranges or artifact.kind != "file":
                    return failed("server asked for ranges we cannot supply")
                chunks = []
                for r in ranges:
                    start, end = int(r.get("start", 0)), int(r.get("end", -1))
                    data = artifact.read_range(start, end)
                    uploaded += len(data)
                    if uploaded > self.max_upload_bytes:
                        # ⚠️ The caller's own ceiling, not the server's. A
                        # scanner that keeps asking must not be able to spend
                        # this host's bandwidth without limit.
                        return failed(f"upload ceiling {self.max_upload_bytes} reached")
                    chunks.append(
                        {"start": start, "end": end, "data_b64": base64.b64encode(data).decode()}
                    )
                body = {
                    "kind": artifact.kind,
                    "source": {**self._source(artifact), "ranges": chunks},
                    "analysis_id": payload.get("id", ""),
                }
                if self.model:
                    body["model"] = self.model
                continue

            if status == 202:
                # ⚠️ Deep analysis is asynchronous and this adapter does NOT poll.
                # Answering it with a manufactured `clean` would be the worst
                # possible outcome, so the record says exactly what happened.
                return failed("analysis is asynchronous; polling is not implemented")

            if status == 413:
                return failed(f"artifact too large for the scanner ({payload.get('limit_bytes')})")

            if status != 200:
                return failed(f"http {status}")

            verdict = payload.get("verdict")
            if verdict not in ("clean", "suspicious", "malicious"):
                # ⚠️ A scanner that answered something we cannot read has told us
                # NOTHING. Not a pass.
                return failed(f"unrecognised verdict {verdict!r}")

            iocs = payload.get("iocs") or {}
            return ScanResult(
                state="fulfilled",
                verdict=verdict,
                provider=self.name,
                analysis_id=str(payload.get("id", ""))[:128],
                detected_type=str(payload.get("detected_type") or iocs.get("detected_type") or "")[:128],
            )

        return failed(f"range negotiation did not converge in {MAX_ROUNDS} rounds")
