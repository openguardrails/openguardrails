"""THE THING TO BE SCANNED — resolved, hashed and sniffed, without loading it.

⚠️ **Never reads the whole artifact into memory.** A 300 MB sample is the case
this axis exists for; `open().read()` would make the client the memory bomb the
whole design is avoiding. Everything here streams.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field
from typing import BinaryIO, Iterator

from .sniff import detect_type, type_mismatch

#: How much of the head a scanner is sent up front. RFC-shaped constant: enough
#: for every signature in `sniff`, small enough to ride the first request.
HEAD_BYTES = 4096

#: Streaming chunk. Not tunable per call: the point is that it is bounded.
_CHUNK = 1 << 20


@dataclass
class Artifact:
    """One artifact, described. `stream` is a factory so it can be re-opened for
    each requested range without holding a descriptor across a network call."""

    kind: str  # file | package | url | text
    locator: str
    declared_type: str = ""
    size: int = 0
    sha256: str = ""
    head: bytes = b""
    detected_type: str = ""
    _open: object = field(default=None, repr=False)

    @property
    def mismatch(self) -> bool:
        """The name and the bytes disagree — a finding in its own right."""
        return type_mismatch(self.declared_type, self.detected_type)

    def read_range(self, start: int, end: int) -> bytes:
        """Bytes `[start, end]` inclusive; `end < 0` means "to the end".

        ⚠️ Inclusive because that is what the wire says (`{"start": 0, "end":
        1048576}`) and what HTTP Range means. Silently treating it as exclusive
        loses one byte per range, which is exactly the kind of off-by-one a
        scanner reports as a corrupt sample rather than as a bug in the client.
        """
        if self._open is None:
            return b""
        with self._open() as fh:  # type: ignore[operator]
            fh.seek(start)
            if end < 0:
                return fh.read()
            return fh.read(end - start + 1)


def _declared_from_name(locator: str) -> str:
    from .sniff import _MAGIC  # noqa: F401  (kept local: see EXT table below)

    name = locator.split("?", 1)[0].split("#", 1)[0]
    _, _, ext = name.rpartition(".")
    return _EXT.get(ext.lower(), "") if ext and ext != name else ""


#: Extension → the type the NAME claims. It is a CLAIM; `sniff.detect_type`
#: produces the counter-claim.
_EXT = {
    "pdf": "application/pdf",
    "doc": "application/msword",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xls": "application/vnd.ms-excel",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    "ppt": "application/vnd.ms-powerpoint",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "zip": "application/zip",
    "gz": "application/gzip",
    "tgz": "application/gzip",
    "tar": "application/x-tar",
    "rar": "application/vnd.rar",
    "7z": "application/x-7z-compressed",
    "exe": "application/vnd.microsoft.portable-executable",
    "dll": "application/vnd.microsoft.portable-executable",
    "msi": "application/x-msi",
    "jar": "application/java-archive",
    "apk": "application/vnd.android.package-archive",
    "so": "application/x-sharedlib",
    "dylib": "application/x-mach-binary",
    "bin": "application/octet-stream",
    "iso": "application/x-iso9660-image",
    "mp4": "video/mp4",
    "mov": "video/quicktime",
    "avi": "video/x-msvideo",
    "mkv": "video/x-matroska",
    "mp3": "audio/mpeg",
    "wav": "audio/wav",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "sh": "text/x-shellscript",
}


def describe_file(path: str, declared_type: str = "") -> Artifact:
    """Hash and sniff a local file, streaming.

    ⚠️ The hash is computed BEFORE anything is uploaded, because a known hash
    answers with no upload at all — that is the whole economy of the contract,
    and the second customer to meet a sample pays nothing.
    """
    size = os.path.getsize(path)
    digest = hashlib.sha256()
    head = b""
    with open(path, "rb") as fh:
        while True:
            chunk = fh.read(_CHUNK)
            if not chunk:
                break
            if len(head) < HEAD_BYTES:
                head += chunk[: HEAD_BYTES - len(head)]
            digest.update(chunk)
    return Artifact(
        kind="file",
        locator=path,
        declared_type=declared_type or _declared_from_name(path),
        size=size,
        sha256=digest.hexdigest(),
        head=head,
        detected_type=detect_type(head),
        _open=lambda: open(path, "rb"),
    )


def describe_locator(kind: str, locator: str) -> Artifact:
    """A package spec, a URL or a block of text — nothing to hash locally.

    ⚠️ A URL is NOT fetched here. Downloading it to hash it would make this client
    the thing that pulls hostile bytes onto the host, which is the opposite of the
    job; the scanner fetches it, in its own sandbox, or it does not.
    """
    if kind not in {"package", "url", "text"}:
        raise ValueError(f"describe_locator: {kind!r} is not a locator kind")
    return Artifact(kind=kind, locator=locator, declared_type=_declared_from_name(locator))
