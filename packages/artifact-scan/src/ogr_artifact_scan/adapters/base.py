"""The adapter contract."""

from __future__ import annotations

from typing import Protocol

from ..artifact import Artifact
from ..result import ScanResult


class AdapterError(Exception):
    """A transport-level failure. The client turns it into a `failed` RESULT —
    adapters raise, the client never lets one escape to the caller."""


class Adapter(Protocol):
    """One dialect.

    ⚠️ `scan` receives a described Artifact and returns a ScanResult. It MUST NOT
    decide policy: a `suspicious` answer is reported as `suspicious`, and what
    happens next belongs to whoever asked.
    """

    name: str

    def scan(self, artifact: Artifact) -> ScanResult: ...
