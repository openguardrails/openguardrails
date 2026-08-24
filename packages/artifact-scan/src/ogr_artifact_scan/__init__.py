"""Fulfil OGR `scan_artifact` obligations.

⚠️⚠️ **THIS IS NOT THE SDK LAYER v0.7 RETIRED.** `packages/python/` and
`packages/javascript/` were removed with the SDK, and `runtime-api.md` still says
"There is no SDK layer" — that rule is about `/v1/evaluate`, and it stands: a PEP
makes two hand-rolled POSTs and needs nothing from anybody.

What lives here is the ARTIFACT recipe, which is a different animal: header
sniffing, streaming hashes, a server-driven range negotiation and four scanner
dialects. It is genuinely too intricate to expect each integrator to reimplement,
and getting it wrong fails in the direction that matters — a client that
manufactures a `clean` cannot be caught afterwards. See
`specification/artifact-scan.md` and `specification/obligations.md`.
"""

from .artifact import Artifact, describe_file, describe_locator
from .obligations import Fulfilment, fulfil, to_obligation_results
from .result import ScanResult, VERDICTS, failed, skipped
from .sniff import detect_type, type_mismatch

__all__ = [
    "Artifact",
    "describe_file",
    "describe_locator",
    "Fulfilment",
    "fulfil",
    "to_obligation_results",
    "ScanResult",
    "VERDICTS",
    "failed",
    "skipped",
    "detect_type",
    "type_mismatch",
]
