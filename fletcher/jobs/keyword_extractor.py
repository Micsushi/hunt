from __future__ import annotations

import re

# Minimal draft when Ollama is off: a few tokens from the title only.
_TITLE_SKIP = frozenset(
    {
        "the",
        "and",
        "for",
        "with",
        "our",
        "job",
        "role",
        "full",
        "time",
        "part",
    }
)


def _draft_terms_from_title(title: str) -> list[str]:
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9+.#-]{2,}", title or "")
    out: list[str] = []
    seen: set[str] = set()
    for t in tokens:
        low = t.lower()
        if low in _TITLE_SKIP:
            continue
        if low in seen:
            continue
        seen.add(low)
        out.append(low)
        if len(out) >= 5:
            break
    return out


def extract_keywords(*, title: str, description: str | None, classification: dict) -> dict:
    """Lightweight draft keywords for the pipeline.

    When ``HUNT_RESUME_MODEL_BACKEND=ollama``, ``llm_enrich`` replaces this with
    model output: jd usability + up to 10 grounded keywords from the posting.
    """
    concern_flags = list(classification.get("concern_flags", []))

    responsibilities = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+", description or "")
        if len(sentence.strip()) > 20
    ][:6]

    seniority_signals = (
        [classification.get("job_level")]
        if classification.get("job_level") not in (None, "unknown")
        else []
    )

    if not description or len(description.strip()) < 120:
        if "weak_description" not in concern_flags:
            concern_flags.append("weak_description")

    draft_must = _draft_terms_from_title(title)

    return {
        "must_have_terms": draft_must,
        "nice_to_have_terms": [],
        "responsibilities": responsibilities,
        "tools_and_technologies": [],
        "domain_terms": [],
        "seniority_signals": seniority_signals,
        "concern_flags": concern_flags,
    }
