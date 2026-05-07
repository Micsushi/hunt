from __future__ import annotations

import re

_MOJIBAKE_MARKERS = (
    "\u00c3",
    "\u00c2",
    "\u0080",
    "\u0099",
    "\u00e2\u20ac",
    "\u00e2\u20ac\u2122",
    "\u00e2\u20ac\u0153",
    "\u00e2\u20ac\ufffd",
    "\u00e2\u20ac\u201c",
    "\u00e2\u20ac\u201d",
)

_C1_TO_CP1252 = {
    "\u0080": "\u20ac",
    "\u0082": "\u201a",
    "\u0083": "\u0192",
    "\u0084": "\u201e",
    "\u0085": "\u2026",
    "\u0086": "\u2020",
    "\u0087": "\u2021",
    "\u0088": "\u02c6",
    "\u0089": "\u2030",
    "\u008a": "\u0160",
    "\u008b": "\u2039",
    "\u008c": "\u0152",
    "\u008e": "\u017d",
    "\u0091": "\u2018",
    "\u0092": "\u2019",
    "\u0093": "\u201c",
    "\u0094": "\u201d",
    "\u0095": "\u2022",
    "\u0096": "\u2013",
    "\u0097": "\u2014",
    "\u0098": "\u02dc",
    "\u0099": "\u2122",
    "\u009a": "\u0161",
    "\u009b": "\u203a",
    "\u009c": "\u0153",
    "\u009e": "\u017e",
    "\u009f": "\u0178",
}


def _restore_cp1252_controls(text: str) -> str:
    return "".join(_C1_TO_CP1252.get(char, char) for char in text)


def _repair_broken_utf8_punctuation(text: str) -> str:
    return (
        text.replace("\u00c3\u00a2\u20ac\u2122", "\u2019")
        .replace("\u00c3\u00a2\u20ac\u0153", "\u201c")
        .replace("\u00c3\u00a2\u20ac\u009d", "\u201d")
        .replace("\u00c3\u00a2\u20ac\u201c", "\u2013")
        .replace("\u00c3\u00a2\u20ac\u201d", "\u2014")
    )


def repair_mojibake(text: str | None) -> str:
    """Repair common UTF-8 text that was decoded as Windows-1252."""
    value = str(text or "")
    if not any(marker in value for marker in _MOJIBAKE_MARKERS):
        return value

    repaired = value
    for _ in range(3):
        repaired = _repair_broken_utf8_punctuation(_restore_cp1252_controls(repaired))
        try:
            candidate = repaired.encode("cp1252").decode("utf-8")
        except UnicodeError:
            break
        if candidate == repaired:
            break
        repaired = candidate
        if not any(marker in repaired for marker in _MOJIBAKE_MARKERS):
            break

    repaired = repaired.replace("\u00a0", " ")
    return re.sub(r"[ \t]+", " ", repaired)
