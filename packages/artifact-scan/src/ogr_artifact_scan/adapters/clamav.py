"""ClamAV over its own socket — the free on-premise floor.

`INSTREAM` is the streaming command: `zINSTREAM\\0`, then length-prefixed chunks,
then a zero-length chunk. The daemon answers one line.

⚠️ **It needs the BYTES**, so this adapter is only ever reachable from a PEP
standing next to the file. The runtime-side arm (package/url/text) cannot use it
and must not offer it — a setting that cannot work is worse than a missing one.
"""

from __future__ import annotations

import socket
import struct

from ..artifact import Artifact
from ..result import ScanResult, failed
from .base import AdapterError

_CHUNK = 1 << 16


class ClamAVAdapter:
    name = "clamav"

    def __init__(self, address: str, *, timeout_s: float = 60.0, max_upload_bytes: int = 256 << 20):
        #: `host:port` or a unix socket path.
        self.address = address
        self.timeout_s = timeout_s
        self.max_upload_bytes = max_upload_bytes

    def _connect(self) -> socket.socket:
        if ":" in self.address and not self.address.startswith("/"):
            host, _, port = self.address.rpartition(":")
            sock = socket.create_connection((host, int(port)), timeout=self.timeout_s)
        else:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(self.timeout_s)
            sock.connect(self.address)
        return sock

    def scan(self, artifact: Artifact) -> ScanResult:
        if artifact.kind != "file":
            return failed("clamav needs the bytes; it cannot answer about a locator")
        if artifact.size > self.max_upload_bytes:
            return failed(f"artifact exceeds the upload ceiling {self.max_upload_bytes}")
        try:
            sock = self._connect()
        except OSError as exc:
            raise AdapterError(f"clamd unreachable: {exc}") from exc
        try:
            sock.sendall(b"zINSTREAM\0")
            sent = 0
            while sent < artifact.size:
                chunk = artifact.read_range(sent, min(sent + _CHUNK, artifact.size) - 1)
                if not chunk:
                    break
                sock.sendall(struct.pack("!L", len(chunk)) + chunk)
                sent += len(chunk)
            sock.sendall(struct.pack("!L", 0))
            reply = sock.recv(4096).decode("utf-8", "replace").strip("\0 \n")
        except OSError as exc:
            raise AdapterError(f"clamd transport: {exc}") from exc
        finally:
            sock.close()

        # `stream: OK` | `stream: <SIG> FOUND` | `... ERROR`
        if reply.endswith("OK"):
            return ScanResult(state="fulfilled", verdict="clean", provider=self.name,
                              detected_type=artifact.detected_type)
        if reply.endswith("FOUND"):
            return ScanResult(state="fulfilled", verdict="malicious", provider=self.name,
                              analysis_id=reply.split(":", 1)[-1].strip()[:128],
                              detected_type=artifact.detected_type)
        # ⚠️ ERROR, or anything this parser does not recognise, is a FAILURE.
        # ClamAV has no `suspicious`: its vocabulary is two-valued, and inventing
        # a third state from a line we could not read would put a confidence in
        # the record the protocol underneath never had.
        return failed(f"clamd said: {reply}", detected_type=artifact.detected_type)
