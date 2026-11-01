"""Applying Verdict ``modifications.spans`` in place.

A span names a string inside the payload AS TRANSPORTED
(``payload.messages.0.content``, ``payload.choices.0.message.content``) and
replaces ``[start:end)`` of it with a placeholder — never the original
(specification/verdict.md). Spans on one path are applied high-offset-first
so earlier replacements cannot shift later offsets; a span whose path does
not resolve to a string is counted, because "no spans resolved" must stay
distinguishable from "no redaction policy" (that count feeds the heartbeat's
``unresolved_spans``).
"""

from __future__ import annotations

_MISSING = object()


def _child(container, segment: str):
    """One path step: list index, dict key, or attribute — in that order."""
    if isinstance(container, (list, tuple)):
        if segment.isdigit() and int(segment) < len(container):
            return container[int(segment)]
        return _MISSING
    if isinstance(container, dict):
        return container.get(segment, _MISSING)
    return getattr(container, segment, _MISSING)


def _set_child(container, segment: str, value) -> bool:
    if isinstance(container, list):
        if segment.isdigit() and int(segment) < len(container):
            container[int(segment)] = value
            return True
        return False
    if isinstance(container, dict):
        container[segment] = value
        return True
    try:
        setattr(container, segment, value)
        return True
    except Exception:
        return False


def _segments(path: str) -> "list[str]":
    segments = path.split(".")
    return segments[1:] if segments and segments[0] == "payload" else segments


def apply_spans(root, spans) -> "tuple[int, int, dict]":
    """Apply every span to ``root`` (the transported payload, or the request
    dict it was projected from — same nested objects, same offsets).

    Returns ``(applied, unresolved, changed)`` where ``changed`` maps each
    rewritten path to its final string, so a caller holding a LIVE object
    (a pydantic ModelResponse) can mirror the rewrite with `write_path`.
    """
    by_path: "dict[str, list]" = {}
    for span in spans or []:
        by_path.setdefault(str(span.get("path", "")), []).append(span)

    applied = unresolved = 0
    changed: "dict[str, str]" = {}
    for path, group in by_path.items():
        segments = _segments(path)
        container = root
        for segment in segments[:-1]:
            container = _child(container, segment)
            if container is _MISSING:
                break
        text = _MISSING if container is _MISSING or not segments else _child(container, segments[-1])
        if not isinstance(text, str):
            unresolved += len(group)
            continue
        # High offsets first: every span still indexes the string as transported.
        for span in sorted(group, key=lambda s: s.get("start", 0), reverse=True):
            start, end = span.get("start", 0), span.get("end", 0)
            if 0 <= start <= end <= len(text):
                text = text[:start] + str(span.get("replacement", "")) + text[end:]
                applied += 1
            else:
                unresolved += 1
        if _set_child(container, segments[-1], text):
            changed[path] = text
        else:
            unresolved += len(group)
    return applied, unresolved, changed


def write_path(root, path: str, value: str) -> bool:
    """Mirror one rewritten string into a live object graph (dicts, lists, or
    attribute-bearing response models). Best-effort; ``False`` = unresolved."""
    segments = _segments(path)
    if not segments:
        return False
    container = root
    for segment in segments[:-1]:
        container = _child(container, segment)
        if container is _MISSING:
            return False
    return _set_child(container, segments[-1], value)
