"""ICAP RESPMOD (RFC 3507) — how every enterprise AV/DLP appliance already
accepts bytes.

⚠️⚠️ **This is the adapter that matters for private deployment.** A bank or a 大厂
has an ICAP endpoint today and no appetite for a new API; asking them to implement
our JSON is asking them not to buy. It is worth more than the other adapters
combined for exactly that reason.

⚠️ **ICAP's answer is BINARY and this adapter says so.** `204 No Modification` =
the appliance changed nothing = clean; `200` with an encapsulated body = it
replaced the content = blocked, reported as `malicious`. There is no `suspicious`
in the protocol, so none is invented — an adapter that cannot express a state must
not fabricate it (`adapters/__init__.py`).
"""

from __future__ import annotations

import socket
from urllib.parse import urlparse

from ..artifact import Artifact
from ..result import ScanResult, failed
from .base import AdapterError

_CHUNK = 1 << 16


class IcapAdapter:
    name = "icap"

    def __init__(self, url: str, *, timeout_s: float = 60.0, max_upload_bytes: int = 256 << 20):
        #: `icap://host:1344/service`
        self.url = url
        self.timeout_s = timeout_s
        self.max_upload_bytes = max_upload_bytes

    def scan(self, artifact: Artifact) -> ScanResult:
        if artifact.kind != "file":
            return failed("icap needs the bytes; it cannot answer about a locator")
        if artifact.size > self.max_upload_bytes:
            return failed(f"artifact exceeds the upload ceiling {self.max_upload_bytes}")

        parsed = urlparse(self.url)
        host, port = parsed.hostname or "", parsed.port or 1344
        service = parsed.path or "/"

        # The encapsulated HTTP response the appliance is being asked about. A
        # scanner keys off the headers (filename, content type) as well as the body.
        res_hdr = (
            "HTTP/1.1 200 OK\r\n"
            f"Content-Length: {artifact.size}\r\n"
            f"Content-Type: {artifact.declared_type or 'application/octet-stream'}\r\n"
            f'Content-Disposition: attachment; filename="{_basename(artifact.locator)}"\r\n'
            "\r\n"
        ).encode()

        # ⚠️ `Encapsulated` offsets are BYTE OFFSETS INTO THE ENCAPSULATED BLOCK,
        # not into the ICAP message, and `res-body` points at the start of the
        # chunked body. Getting this wrong makes the appliance answer 400 — which
        # this adapter would report as a failure, correctly, but the sample would
        # go unscanned forever.
        icap_hdr = (
            f"RESPMOD {self.url} ICAP/1.0\r\n"
            f"Host: {host}:{port}\r\n"
            "Allow: 204\r\n"
            f"Encapsulated: res-hdr=0, res-body={len(res_hdr)}\r\n"
            "\r\n"
        ).encode()

        try:
            sock = socket.create_connection((host, port), timeout=self.timeout_s)
        except OSError as exc:
            raise AdapterError(f"icap unreachable: {exc}") from exc
        try:
            sock.sendall(icap_hdr + res_hdr)
            sent = 0
            while sent < artifact.size:
                chunk = artifact.read_range(sent, min(sent + _CHUNK, artifact.size) - 1)
                if not chunk:
                    break
                sock.sendall(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                sent += len(chunk)
            sock.sendall(b"0\r\n\r\n")
            reply = _read_status(sock)
        except OSError as exc:
            raise AdapterError(f"icap transport: {exc}") from exc
        finally:
            sock.close()
        return _map_status(reply, artifact, self.name)


def _basename(locator: str) -> str:
    return locator.rsplit("/", 1)[-1].replace('"', "")


def _read_status(sock: socket.socket) -> str:
    buf = b""
    while b"\r\n" not in buf and len(buf) < 4096:
        piece = sock.recv(4096)
        if not piece:
            break
        buf += piece
    return buf.split(b"\r\n", 1)[0].decode("utf-8", "replace")


def _map_status(status_line: str, artifact: Artifact, provider: str) -> ScanResult:
    parts = status_line.split()
    code = parts[1] if len(parts) > 1 and parts[1].isdigit() else ""
    if code == "204":
        return ScanResult(state="fulfilled", verdict="clean", provider=provider,
                          detected_type=artifact.detected_type)
    if code == "200":
        # The appliance rewrote the content — for an AV service that means it
        # replaced the file with a block page.
        return ScanResult(state="fulfilled", verdict="malicious", provider=provider,
                          detected_type=artifact.detected_type)
    # ⚠️ 400/500/anything else is a FAILURE. An appliance that refused the request
    # has not told us the file is clean.
    return failed(f"icap said: {status_line}", detected_type=artifact.detected_type)
