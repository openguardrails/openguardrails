"""The rules that fail in the direction nobody can catch afterwards."""

from __future__ import annotations

import os
import tempfile

import pytest

from ogr_artifact_scan import describe_file, fulfil, to_obligation_results
from ogr_artifact_scan.adapters.base import AdapterError
from ogr_artifact_scan.adapters.http_json import HttpJsonAdapter
from ogr_artifact_scan.adapters.icap import _map_status
from ogr_artifact_scan.artifact import describe_locator
from ogr_artifact_scan.result import ScanResult
from ogr_artifact_scan.sniff import detect_type, type_mismatch


@pytest.fixture()
def exe_named_mp4():
    path = tempfile.mktemp(suffix=".mp4")
    with open(path, "wb") as fh:
        fh.write(b"MZ\x90\x00" + b"\x00" * 8192)
    yield path
    os.unlink(path)


# ── the signal that survives everything ──────────────────────────────────────

def test_the_headline_case(exe_named_mp4):
    """A 300 MB executable wearing an .mp4 name — the case the axis exists for."""
    art = describe_file(exe_named_mp4)
    assert art.declared_type == "video/mp4"
    assert art.detected_type == "application/vnd.microsoft.portable-executable"
    assert art.mismatch is True


def test_a_container_is_not_a_mismatch():
    # .docx really IS a zip. Flagging it would flag every Office document ever
    # opened, which is how a signal gets switched off.
    assert type_mismatch(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/zip",
    ) is False


def test_not_knowing_is_never_a_mismatch():
    assert type_mismatch("video/mp4", "") is False
    assert type_mismatch("", "application/zip") is False
    assert detect_type(b"nothing recognisable here") == ""


def test_the_hash_is_computed_without_loading_the_file(exe_named_mp4):
    art = describe_file(exe_named_mp4)
    assert len(art.sha256) == 64
    assert art.size == 8196
    # Ranges are INCLUSIVE, as the wire and HTTP Range both mean.
    assert art.read_range(0, 1) == b"MZ"
    assert len(art.read_range(0, 3)) == 4


# ── nothing may manufacture a pass ───────────────────────────────────────────

class _Stub(HttpJsonAdapter):
    def __init__(self, replies):
        super().__init__("http://scanner.test", "k")
        self.replies = list(replies)
        self.sent = []

    def _post(self, path, body):
        self.sent.append(body)
        return self.replies.pop(0)


def test_a_202_is_not_a_pass(exe_named_mp4):
    a = _Stub([(202, {"status": "queued", "id": "an_1"})])
    r = a.scan(describe_file(exe_named_mp4))
    assert r.state == "failed" and r.verdict == ""
    assert "asynchronous" in r.reason


def test_an_unrecognised_verdict_is_not_a_pass(exe_named_mp4):
    a = _Stub([(200, {"id": "an_1", "verdict": "probably-fine"})])
    r = a.scan(describe_file(exe_named_mp4))
    assert r.state == "failed" and r.verdict == ""


def test_a_non_200_is_not_a_pass(exe_named_mp4):
    a = _Stub([(503, {})])
    assert a.scan(describe_file(exe_named_mp4)).state == "failed"


def test_suspicious_is_reported_as_itself(exe_named_mp4):
    # A scanner is a DETECTOR; whether `suspicious` stops the action belongs to
    # whoever asked, and this client must not decide it.
    a = _Stub([(200, {"id": "an_2", "verdict": "suspicious"})])
    r = a.scan(describe_file(exe_named_mp4))
    assert r.state == "fulfilled" and r.verdict == "suspicious"


# ── hash first, then only the ranges the server asks for ─────────────────────

def test_hash_first_uploads_nothing_when_the_hash_settles_it(exe_named_mp4):
    a = _Stub([(200, {"id": "an_3", "verdict": "malicious"})])
    a.scan(describe_file(exe_named_mp4))
    assert len(a.sent) == 1
    src = a.sent[0]["source"]
    assert "sha256" in src and "head_b64" in src
    assert "ranges" not in src  # nothing uploaded


def test_the_server_drives_the_range_loop(exe_named_mp4):
    a = _Stub([
        (206, {"status": "need_ranges", "id": "an_4", "ranges": [{"start": 0, "end": 15}]}),
        (200, {"id": "an_4", "verdict": "clean"}),
    ])
    r = a.scan(describe_file(exe_named_mp4))
    assert r.verdict == "clean"
    assert len(a.sent[1]["source"]["ranges"]) == 1


def test_the_loop_is_bounded(exe_named_mp4):
    never = [(206, {"status": "need_ranges", "id": "x", "ranges": [{"start": 0, "end": 3}]})] * 3
    a = _Stub(never)
    r = a.scan(describe_file(exe_named_mp4))
    assert r.state == "failed" and "converge" in r.reason


def test_the_upload_ceiling_is_the_callers(exe_named_mp4):
    a = _Stub([(206, {"status": "need_ranges", "id": "x", "ranges": [{"start": 0, "end": -1}]})])
    a.max_upload_bytes = 16
    r = a.scan(describe_file(exe_named_mp4))
    assert r.state == "failed" and "ceiling" in r.reason


def test_a_package_carries_its_ecosystem():
    a = _Stub([(200, {"id": "an_5", "verdict": "clean"})])
    a.scan(describe_locator("package", "npm:left-pad@9.9.9"))
    assert a.sent[0]["source"] == {"package": "npm:left-pad@9.9.9"}


# ── obligations ──────────────────────────────────────────────────────────────

class _Fake:
    name = "fake"

    def __init__(self, result=None, raises=False):
        self.result = result or ScanResult(state="fulfilled", verdict="clean", provider="fake")
        self.raises = raises

    def scan(self, artifact):
        if self.raises:
            raise AdapterError("scanner unreachable")
        return self.result


def _obligation(path, kind="file"):
    return {
        "id": "evt#0.0",
        "type": "scan_artifact",
        "call_id": "c1",
        "artifact": {"kind": kind, "locator": path, "declared_type": "video/mp4"},
        "on_unfulfilled": "flag",
    }


def test_on_error_has_no_default():
    with pytest.raises(ValueError):
        fulfil([], _Fake(), on_error="")


def test_a_scanner_outage_is_a_failed_result_not_an_exception(exe_named_mp4):
    fs = fulfil([_obligation(exe_named_mp4)], _Fake(raises=True), on_error="proceed")
    assert fs[0].result.state == "failed"
    # ⚠️ And the locally-sniffed type is STILL attached: it is the one finding
    # that survives every degraded mode.
    assert fs[0].result.detected_type == "application/vnd.microsoft.portable-executable"
    assert fs[0].type_mismatch is True


def test_on_error_refuse_blocks_where_proceed_does_not(exe_named_mp4):
    o = [_obligation(exe_named_mp4)]
    assert fulfil(o, _Fake(raises=True), on_error="proceed")[0].should_block() is False
    assert fulfil(o, _Fake(raises=True), on_error="refuse")[0].should_block() is True


def test_an_unhandled_kind_is_SKIPPED_and_reported(exe_named_mp4):
    # ⚠️ Silence is counted by the runtime as the gap in the control. A decision
    # somebody made must not be mistaken for one.
    fs = fulfil([_obligation("npm:x@1", kind="package")], _Fake(), on_error="proceed", kinds=["file"])
    assert fs[0].result.state == "skipped"
    assert to_obligation_results(fs)[0]["state"] == "skipped"


def test_an_unsupported_obligation_type_is_skipped_not_dropped():
    fs = fulfil([{"id": "a", "type": "require_approval"}], _Fake(), on_error="proceed")
    assert fs[0].result.state == "skipped"


def test_a_missing_file_is_failed_not_a_crash():
    fs = fulfil([_obligation("/nonexistent/nope.mp4")], _Fake(), on_error="proceed")
    assert fs[0].result.state == "failed" and "not found" in fs[0].result.reason


def test_the_report_omits_empty_fields(exe_named_mp4):
    fs = fulfil([_obligation(exe_named_mp4)], _Fake(), on_error="proceed")
    out = to_obligation_results(fs)[0]
    # `""` would assert "the scanner answered, with nothing" — a different claim
    # from "it did not answer".
    assert "reason" not in out
    assert out["id"] == "evt#0.0" and out["verdict"] == "clean"


# ── ICAP is binary, and says so ──────────────────────────────────────────────

def test_icap_204_is_clean_and_200_is_blocked(exe_named_mp4):
    art = describe_file(exe_named_mp4)
    assert _map_status("ICAP/1.0 204 No Modification", art, "icap").verdict == "clean"
    assert _map_status("ICAP/1.0 200 OK", art, "icap").verdict == "malicious"
    # ⚠️ Anything else is a FAILURE. An appliance that refused the request has
    # not told us the file is clean.
    bad = _map_status("ICAP/1.0 400 Bad Request", art, "icap")
    assert bad.state == "failed" and bad.verdict == ""
