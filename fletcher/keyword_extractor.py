from __future__ import annotations

import re
from collections import Counter

STOPWORDS = {
    "the",
    "and",
    "with",
    "for",
    "that",
    "this",
    "you",
    "your",
    "are",
    "our",
    "will",
    "from",
    "into",
    "have",
    "has",
    "using",
    "use",
    "work",
    "team",
    "teams",
    "job",
    "role",
    "experience",
    "required",
    "preferred",
}

KNOWN_TECH_PHRASES = [
    "python",
    "java",
    "kotlin",
    "typescript",
    "javascript",
    "react",
    "next.js",
    "vue.js",
    "fastapi",
    "flask",
    "docker",
    "kubernetes",
    "postgresql",
    "aws",
    "terraform",
    "datadog",
    "rest api",
    "machine learning",
    "data analysis",
    "product management",
    "agile",
    "scrum",
]


def extract_keywords(*, title: str, description: str | None, classification: dict) -> dict:
    text = f"{title}\n{description or ''}".lower()
    concern_flags = list(classification.get("concern_flags", []))

    matched_phrases = [phrase for phrase in KNOWN_TECH_PHRASES if phrase in text]
    tokens = re.findall(r"[a-zA-Z][a-zA-Z0-9.+#/-]{2,}", text)
    counts = Counter(token for token in tokens if token not in STOPWORDS)

    must_haves = matched_phrases[:8]
    if len(must_haves) < 8:
        for token, _ in counts.most_common(20):
            if token not in must_haves:
                must_haves.append(token)
            if len(must_haves) >= 8:
                break

    nice_to_haves = []
    for token, _ in counts.most_common(40):
        if token not in must_haves and token not in nice_to_haves:
            nice_to_haves.append(token)
        if len(nice_to_haves) >= 8:
            break

    responsibilities = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+", description or "")
        if sentence.strip()
    ][:6]

    seniority_signals = (
        [classification.get("job_level")]
        if classification.get("job_level") not in (None, "unknown")
        else []
    )
    if not description or len(description.strip()) < 120:
        if "weak_description" not in concern_flags:
            concern_flags.append("weak_description")

    return {
        "must_have_terms": must_haves,
        "nice_to_have_terms": nice_to_haves,
        "responsibilities": responsibilities,
        "tools_and_technologies": matched_phrases[:12],
        "domain_terms": nice_to_haves[:6],
        "seniority_signals": seniority_signals,
        "concern_flags": concern_flags,
    }
