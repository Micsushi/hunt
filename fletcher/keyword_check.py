from __future__ import annotations

import re


def _normalize_for_match(value: str) -> str:
    """Normalize spelling-only variants without making semantic tech guesses."""
    text = (value or "").lower()
    text = re.sub(r"\brestful\b", "rest", text)
    text = re.sub(r"[^a-z0-9+#]+", " ", text)
    tokens = []
    for token in text.split():
        if token.endswith("ies") and len(token) > 4:
            token = f"{token[:-3]}y"
        elif token.endswith("ing") and len(token) > 5:
            token = token[:-3]
        elif token.endswith("es") and len(token) > 4:
            token = token[:-2]
        elif token.endswith("s") and len(token) > 3:
            token = token[:-1]
        tokens.append(token)
    return " ".join(tokens)


def _kw_in_text(keyword: str, text: str) -> bool:
    """Case-insensitive lexical match without semantic related-tech aliases."""
    kw = keyword.strip()
    if not kw:
        return False
    normalized_kw = _normalize_for_match(kw)
    normalized_text = _normalize_for_match(text)
    if not normalized_kw or not normalized_text:
        return False
    return f" {normalized_kw} " in f" {normalized_text} "


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
