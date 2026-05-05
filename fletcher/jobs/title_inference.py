from __future__ import annotations

import re

SECTION_HEADINGS = {
    "about us",
    "role summary",
    "what you will do",
    "what you will bring",
    "desirable",
    "ready to join us?",
    "what's great about sophos?",
    "our commitment to you",
    "data protection",
}

TITLE_TERMS = (
    "engineer",
    "developer",
    "analyst",
    "manager",
    "designer",
    "architect",
    "specialist",
    "consultant",
    "intern",
)


def _clean_heading(text: str) -> str:
    value = re.sub(r"[*#_`]+", "", text or "")
    value = re.sub(r"\s+", " ", value).strip(" :-")
    return value.strip()


def normalize_title_candidate(text: str) -> str:
    candidate = _clean_heading(text)
    if not candidate:
        return ""
    candidate = re.sub(r"(?i)\binterns\b$", "Intern", candidate).strip()
    if candidate.lower() in SECTION_HEADINGS:
        return ""

    metadata_prefixes = (
        "function:",
        "location:",
        "employment status:",
        "pay range:",
        "req id:",
        "job segment:",
    )
    if any(candidate.lower().startswith(p) for p in metadata_prefixes):
        return ""

    if len(candidate.split()) > 8:
        return ""
    if not any(term in candidate.lower() for term in TITLE_TERMS):
        return ""
    return candidate


def infer_title_from_description(description: str) -> str:
    text = description or ""
    explicit_patterns = [
        r"(?im)^\s*(?:job\s*)?title\s*[:\-]\s*(.+)$",
        r"(?im)^\s*position\s*[:\-]\s*(.+)$",
        r"(?im)^\s*role\s*[:\-]\s*(.+)$",
    ]
    for pattern in explicit_patterns:
        match = re.search(pattern, text)
        if match:
            candidate = normalize_title_candidate(match.group(1))
            if candidate:
                return candidate

    prose_patterns = [
        r"(?i)\bwe(?:\s+are|'re)\s+looking\s+for\s+(?:an?\s+)?(?:[*_`#]+)?([A-Z][A-Za-z0-9+/# .,&-]{2,80}?)(?:[*_`#]+)?\s+(?:for|to|on|in|at)\b",
        r"(?i)\bwe(?:\s+are|'re)\s+hiring\s+(?:an?\s+)?(?:[*_`#]+)?([A-Z][A-Za-z0-9+/# .,&-]{2,80}?)(?:[*_`#]+)?(?:\.|,|\n|!|\s+for\b)",
        r"(?i)\bseeking\s+(?:an?\s+)?([A-Z][A-Za-z0-9+/# .,&-]{2,80}?)\s+to\s+join\b",
        r"(?i)\bjoin\s+.*?\s+as\s+(?:an?\s+)?([A-Z][A-Za-z0-9+/# .,&-]{2,80}?)(?:\.|,|\n)",
        r"(?i)\bthis position is for\s+(?:an?\s+)?([A-Z][A-Za-z0-9+/# .,&-]{2,80}?)(?:\.|,|\n)",
    ]
    for pattern in prose_patterns:
        match = re.search(pattern, text)
        if match:
            candidate = normalize_title_candidate(match.group(1))
            if candidate:
                return candidate

    for line in text.splitlines()[:12]:
        candidate = normalize_title_candidate(line)
        if candidate:
            return candidate
    return ""
