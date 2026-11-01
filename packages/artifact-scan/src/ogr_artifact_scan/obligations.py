"""FULFILLING A RUNTIME'S OBLIGATIONS — the PEP half of the artifact axis.

A verdict may carry `obligations[]` (`specification/obligations.md`). This turns
each `scan_artifact` obligation into a scanner call and produces the
`obligation_results[]` the NEXT `step/request` carries back.

⚠️ **`on_error` HAS NO SAFE DEFAULT and this module refuses to pick one.**
Fail-open silently removes the control at the moment it is needed; fail-closed
turns the scanner's outage into the customer's outage. It is a required argument,
which is the same lesson `OGR_DETECTOR_FAIL_MODE` records from the other side —
the failure that looks like a speed-up.

⚠️ **Nothing here decides policy.** `should_block` reports what the OBLIGATION and
the scanner said; whether `suspicious` stops an action belongs to the runtime that
issued the obligation, and this library never rewrites a verdict.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

from .adapters.base import Adapter, AdapterError
from .artifact import Artifact, describe_file, describe_locator
from .result import ScanResult, failed, skipped
from .sniff import type_mismatch


@dataclass
class Fulfilment:
    obligation: dict
    result: ScanResult

    @property
    def id(self) -> str:
        return str(self.obligation.get("id", ""))

    @property
    def on_unfulfilled(self) -> str:
        return str(self.obligation.get("on_unfulfilled", "flag"))

    @property
    def type_mismatch(self) -> bool:
        """The name claimed one thing and the bytes said another.

        ⚠️ Reported SEPARATELY from the verdict, and it survives everything: a
        refused upload, an exhausted quota, an unreachable scanner. It is the one
        signal this client can produce on its own.
        """
        return bool(self.result.detected_type) and type_mismatch(
            str((self.obligation.get("artifact") or {}).get("declared_type", "")),
            self.result.detected_type,
        )

    def should_block(self, *, block_suspicious: bool = False) -> bool:
        if self.result.verdict == "malicious":
            return True
        if self.result.verdict == "suspicious" and block_suspicious:
            return True
        if not self.result.ok:
            return self._error_blocks
        return False

    _error_blocks: bool = False


def _resolve(obligation: dict, resolver: Callable[[str, str], Artifact] | None) -> Artifact:
    art = obligation.get("artifact") or {}
    kind = str(art.get("kind", ""))
    locator = str(art.get("locator", ""))
    declared = str(art.get("declared_type", ""))
    if resolver is not None:
        return resolver(kind, locator)
    if kind == "file":
        # ⚠️ The locator is the AGENT's own string and only the PEP knows what
        # working directory it means. This resolves it in THIS process's cwd,
        # which is the agent's — a library running anywhere else must pass its
        # own `resolver` rather than let a path be guessed.
        return describe_file(locator, declared_type=declared)
    return describe_locator(kind, locator)


def fulfil(
    obligations: Iterable[dict],
    adapter: Adapter,
    *,
    on_error: str,
    resolver: Callable[[str, str], Artifact] | None = None,
    kinds: Sequence[str] | None = None,
) -> list[Fulfilment]:
    """Answer each `scan_artifact` obligation. Never raises.

    `on_error` is `"proceed"` or `"refuse"` and is REQUIRED — see the module note.
    `kinds` narrows what this PEP will handle; anything outside it is reported
    `skipped`, which is a decision somebody made and must not be counted as the
    silence that names a gap in the control.
    """
    if on_error not in ("proceed", "refuse"):
        raise ValueError("on_error must be 'proceed' or 'refuse' — there is no safe default")

    out: list[Fulfilment] = []
    for obligation in obligations:
        if obligation.get("type") != "scan_artifact":
            # ⚠️ An obligation type this library does not implement is SKIPPED and
            # reported. Dropping it silently would make the runtime count it as
            # nobody having checked, which is a different and more alarming fact.
            out.append(Fulfilment(obligation, skipped("unsupported obligation type")))
            continue

        art_kind = str((obligation.get("artifact") or {}).get("kind", ""))
        if kinds is not None and art_kind not in kinds:
            out.append(Fulfilment(obligation, skipped(f"this integration does not handle {art_kind}")))
            continue

        try:
            artifact = _resolve(obligation, resolver)
        except FileNotFoundError:
            out.append(Fulfilment(obligation, failed("artifact not found at the locator")))
            continue
        except OSError as exc:
            out.append(Fulfilment(obligation, failed(f"could not read the artifact: {exc}")))
            continue

        try:
            result = adapter.scan(artifact)
        except AdapterError as exc:
            result = failed(str(exc), detected_type=artifact.detected_type)
        except Exception as exc:  # noqa: BLE001 — a client bug must not break the agent
            result = failed(f"adapter raised: {exc}", detected_type=artifact.detected_type)

        # ⚠️ The locally-sniffed type is attached even when the scan failed: it is
        # the one finding that survives every degraded mode.
        if not result.detected_type and artifact.detected_type:
            result.detected_type = artifact.detected_type

        f = Fulfilment(obligation, result)
        f._error_blocks = on_error == "refuse"
        out.append(f)
    return out


def to_obligation_results(fulfilments: Iterable[Fulfilment]) -> list[dict]:
    """The array the NEXT `step/request` carries back to the runtime.

    ⚠️ Report EVERY obligation, including the skipped and failed ones. An
    obligation whose result never arrives is counted as `unfulfilled` — the gap in
    the control — and letting a deliberate skip or a scanner outage be counted as
    silence makes the only number that measures this axis unreadable.
    """
    return [f.result.to_obligation_result(f.id) for f in fulfilments]
