from __future__ import annotations

import re


def _kw_in_text(keyword: str, text: str) -> bool:
    """Case-insensitive match. Multi-word or special-char keywords: substring. Single word: whole-word."""
    kw = keyword.strip()
    if not kw:
        return False
    if " " in kw or not re.match(r"^\w+$", kw):
        return kw.lower() in text.lower()
    return bool(re.search(r"(?i)\b" + re.escape(kw) + r"\b", text))


def partition_keywords(
    keywords: list[str],
    all_bullets: list[str],
) -> tuple[list[str], list[str], dict[str, list[int]]]:
    """Split keywords into present/missing based on bullet text coverage.

    Returns:
      present  : keywords already found in at least one bullet
      missing  : keywords not found anywhere
      coverage : {keyword: [bullet_indices where it appears]}
    """
    present: list[str] = []
    missing: list[str] = []
    coverage: dict[str, list[int]] = {}

    for kw in keywords:
        hits = [i for i, b in enumerate(all_bullets) if _kw_in_text(kw, b)]
        if hits:
            present.append(kw)
            coverage[kw] = hits
        else:
            missing.append(kw)
            coverage[kw] = []

    return present, missing, coverage
