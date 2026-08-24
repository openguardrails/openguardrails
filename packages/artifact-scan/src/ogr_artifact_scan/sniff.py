"""WHAT THE BYTES ACTUALLY ARE, against what the name claimed.

⚠️ **This is the cheapest and most durable signal in the whole artifact axis, and
it is the reason this module exists before any network code.** It needs the first
few KiB and a magic-number table, and it survives a refused upload, an exhausted
quota, an unreachable scanner and a provider that answers nothing useful. The
headline case for the entire feature — a 300 MB executable wearing an `.mp4`
name — is exactly a `declared_type` the first four bytes disagree with.

A caller SHOULD report a disagreement even when no analysis completed.
"""

from __future__ import annotations

# (offset, magic, media type). Ordered: the first match wins, so longer and more
# specific signatures come first.
#
# ⚠️ Deliberately SHORT. It covers what a scanner's `declared_type` is worth
# checking against — executables, archives, documents, the media containers an
# executable likes to hide behind — and answers "" for everything else rather
# than guessing. A wrong detected_type is worse than none: it turns a real
# mismatch into a false one and a false one into noise nobody trusts.
_MAGIC: list[tuple[int, bytes, str]] = [
    (0, b"MZ", "application/vnd.microsoft.portable-executable"),
    (0, b"\x7fELF", "application/x-executable"),
    (0, b"\xca\xfe\xba\xbe", "application/x-mach-binary"),
    (0, b"\xcf\xfa\xed\xfe", "application/x-mach-binary"),
    (0, b"\xfe\xed\xfa\xce", "application/x-mach-binary"),
    (0, b"%PDF-", "application/pdf"),
    (0, b"PK\x03\x04", "application/zip"),
    (0, b"\x1f\x8b", "application/gzip"),
    (0, b"BZh", "application/x-bzip2"),
    (0, b"\xfd7zXZ\x00", "application/x-xz"),
    (0, b"Rar!\x1a\x07", "application/vnd.rar"),
    (0, b"7z\xbc\xaf\x27\x1c", "application/x-7z-compressed"),
    (0, b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", "application/x-ole-storage"),
    (0, b"\x89PNG\r\n\x1a\n", "image/png"),
    (0, b"\xff\xd8\xff", "image/jpeg"),
    (0, b"GIF87a", "image/gif"),
    (0, b"GIF89a", "image/gif"),
    (0, b"ID3", "audio/mpeg"),
    (0, b"OggS", "application/ogg"),
    (0, b"fLaC", "audio/flac"),
    (0, b"\x1aE\xdf\xa3", "video/x-matroska"),
    (0, b"#!", "text/x-shellscript"),
    (4, b"ftyp", "video/mp4"),
    (8, b"WAVE", "audio/wav"),
    (8, b"AVI ", "video/x-msvideo"),
]

# ZIP is a container: .docx/.xlsx/.pptx/.jar/.apk are all `PK\x03\x04`. Refining
# it needs the central directory, which the first 4 KiB does not reliably hold —
# so this reports the container honestly rather than guessing which document it is.
ZIP_CONTAINER = "application/zip"


def detect_type(head: bytes) -> str:
    """The media type the BYTES claim. `""` when nothing here recognises them.

    ⚠️ Returns `""` rather than `application/octet-stream`: "we did not recognise
    this" and "this is opaque binary data" are different statements, and only the
    first one is true here.
    """
    for offset, magic, media_type in _MAGIC:
        if head[offset : offset + len(magic)] == magic:
            return media_type
    return ""


# Families that are the SAME claim in different words — a mismatch between two
# members of one row is not a mismatch at all.
_EQUIVALENT: list[set[str]] = [
    {
        "application/zip",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/java-archive",
        "application/vnd.android.package-archive",
        "application/epub+zip",
    },
    {
        "application/x-ole-storage",
        "application/msword",
        "application/vnd.ms-excel",
        "application/vnd.ms-powerpoint",
        "application/vnd.ms-excel.sheet.macroEnabled.12",
    },
    {"application/gzip", "application/x-tar"},
]


def type_mismatch(declared: str, detected: str) -> bool:
    """Do the name and the bytes disagree in a way worth reporting?

    ⚠️ **Absence is never a mismatch.** An unrecognised head or an extension-less
    name means we do not know, and reporting "mismatch" for not-knowing would bury
    the real ones — the finding has to stay rare enough to be read.

    ⚠️ **A CONTAINER is not a mismatch.** `.docx` really is a zip; `.xlsm` really
    is an OLE compound file. Treating those as disagreement would flag every
    Office document ever opened, which is how a signal gets switched off.
    """
    if not declared or not detected:
        return False
    if declared == detected:
        return False
    for family in _EQUIVALENT:
        if declared in family and detected in family:
            return False
    return True
