"""
Search lane classification for discovery (all job boards).

Discovery runs queries from ``SEARCH_TERMS`` in ``hunter.config``, grouped into role
lanes. Boards often return noisy rows, so after fetch we require the **job title** to
still match the **lane** of the query that produced the row.

This module is board-agnostic: the same check applies to LinkedIn, Indeed, and any future
``source`` stored on ``jobs`` with a ``category`` lane id.
"""

import re
import unicodedata

# Lane ids must match keys in hunter.config.SEARCH_TERMS.
LANE_ENGINEERING = "engineering"
LANE_PRODUCT = "product"
LANE_DATA = "data"
LANE_IT_SUPPORT = "it_support"
LANE_QUALITY_SECURITY = "quality_security"
LANE_HARDWARE = "hardware"

# Substrings on accent-folded, lowercased titles. Extend when SEARCH_TERMS changes.
LANE_TITLE_KEYWORDS = {
    LANE_ENGINEERING: (
        "software",
        "developer",
        "engineer",
        "frontend",
        "front-end",
        "backend",
        "back-end",
        "fullstack",
        "full stack",
        "web developer",
        "application developer",
        "devops",
        "sdet",
        "qa engineer",
        ".net",
        "ingenieur",
        "developpeur",
        "logiciel",
    ),
    LANE_PRODUCT: (
        "project coordinator",
        "implementation specialist",
        "solutions engineer",
        "technical customer success",
        "product manager",
        "project manager",
        "program manager",
        "associate product manager",
        "product owner",
        "scrum",
        "business analyst",
        "business analysis",
        "gestionnaire de produit",
        "chef de produit",
        "analyste d'affaires",
        "analyste daffaires",
    ),
    LANE_DATA: (
        "business analyst",
        "operations analyst",
        "data analyst",
        "data scientist",
        "data engineer",
        "data science",
        "machine learning",
        "ml engineer",
        "analytics engineer",
        "business intelligence",
        "bi developer",
        "bi analyst",
        "analyste de donnees",
        "scientifique des donnees",
        "donnees",
    ),
    LANE_IT_SUPPORT: (
        "information technology",
        "it analyst",
        "it compliance",
        "it operations",
        "it specialist",
        "it technician",
        "helpdesk",
        "systems support",
        "system support",
        "it support",
        "support ti",
        "soutien informatique",
        "support informatique",
        "technicien informatique",
        "assistance informatique",
        "it customer support",
        "end user support",
        "end-user support",
        "technical support",
        "help desk",
        "service desk",
        "desktop support",
        "application support",
        "systems administrator",
        "system administrator",
        "network administrator",
        "database administrator",
        "network support",
        "noc",
        "data centre",
        "data center",
        "computer technician",
        "field service",
    ),
    LANE_QUALITY_SECURITY: (
        "qa",
        "quality assurance",
        "test engineer",
        "automation engineer",
        "test automation",
        "sdet",
        "security",
        "cyber",
    ),
    LANE_HARDWARE: (
        "embedded",
        "firmware",
        "robotics",
        "hardware",
        "electronics",
        "deployment technician",
        "repair technician",
    ),
}

_PM_TOKEN = re.compile(r"(?<![a-z])pm(?![a-z])")


def canonicalize_title_text(value):
    if not value or not isinstance(value, str):
        return ""
    normalized = unicodedata.normalize("NFKD", value)
    without_accents = "".join(char for char in normalized if not unicodedata.combining(char))
    return " ".join(without_accents.lower().split())


def title_matches_search_lane(title, lane):
    """
    Return True if ``title`` fits the configured discovery ``lane``.

    Empty or unknown ``lane``: True (no second-pass filter; caller should still set category from query).
    """
    if not title or not isinstance(title, str):
        return False

    from hunter.config import (
        _DEFAULT_SEARCH_TERMS,
        EXPERIENCE_LEVELS,
        SEARCH_TERMS,
        TARGET_JOB_TITLES,
        TARGETING_CONFIGURED,
    )

    if TARGETING_CONFIGURED:
        return title_matches_target_preferences(title, lane, TARGET_JOB_TITLES, EXPERIENCE_LEVELS)

    # Keep the established synonyms for unchanged defaults. Custom lanes and
    # overrides use their actual configured phrases on every source.
    if lane in SEARCH_TERMS and SEARCH_TERMS[lane] != _DEFAULT_SEARCH_TERMS.get(lane):
        title_key = canonicalize_title_text(title)
        return any(
            re.search(r"(?<!\w)" + re.escape(phrase) + r"(?!\w)", title_key)
            for term in SEARCH_TERMS[lane]
            if (phrase := canonicalize_title_text(term))
        )

    keywords = LANE_TITLE_KEYWORDS.get(lane)
    if not keywords:
        return True

    title_key = canonicalize_title_text(title)
    if lane == LANE_IT_SUPPORT:
        # Canadian occupation codes are not Network Operations Centre roles.
        title_key = re.sub(r"\bnoc(?:\s+code)?[\s:#()-]*\d{4,5}\b", "", title_key)
    if lane == LANE_PRODUCT and _PM_TOKEN.search(title_key):
        return True
    return any(
        bool(re.search(r"\b" + re.escape(keyword) + r"\b", title_key))
        if keyword == "noc" or keyword.startswith("it ")
        else keyword in title_key
        for keyword in keywords
    )


def matching_search_lane(title):
    """Return the first configured role category, or None for an unrelated title."""
    from hunter.config import SEARCH_TERMS

    return next((lane for lane in SEARCH_TERMS if title_matches_search_lane(title, lane)), None)


EXPERIENCE_LEVEL_QUERY_TERMS = {
    "internship": ("intern", "internship", "co-op", "student"),
    "junior": (
        "junior",
        "entry level",
        "associate",
        "level 1",
        "level one",
        "l1",
        "i",
        "1",
    ),
    "new_grad": ("new grad", "graduate", "entry level"),
}

EXPERIENCE_LEVEL_KEYWORDS = {
    "internship": ("intern", "internship", "co-op", "coop", "student"),
    "junior": (
        "junior",
        "jr.",
        "jr",
        "associate",
        "entry level",
        "entry-level",
        "engineer i",
        "developer i",
        "analyst i",
        "scientist i",
        "level 1",
        "level one",
        "l1",
    ),
    "new_grad": (
        "new grad",
        "new graduate",
        "recent graduate",
        "university graduate",
        "graduate",
        "entry level",
        "entry-level",
    ),
}

_TARGET_TITLE_SUFFIX_VARIANTS = {
    " engineer": " engineering",
    " developer": " development",
    " scientist": " science",
}


def _contains_phrase(text, phrase):
    return re.search(rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])", text) is not None


def build_search_queries(target_job_titles, experience_levels):
    """Combine user-selected role titles with the aliases for selected levels."""
    queries_by_lane = {}
    for lane, titles in target_job_titles.items():
        queries = []
        seen = set()
        for title in titles:
            title_key = canonicalize_title_text(title)
            if not title_key:
                continue
            for level in experience_levels or ["all"]:
                for level_term in EXPERIENCE_LEVEL_QUERY_TERMS.get(
                    level, ("",) if level == "all" else ()
                ):
                    query = f"{title_key} {level_term}".strip()
                    if query in seen:
                        continue
                    seen.add(query)
                    queries.append(query)
        if queries:
            queries_by_lane[str(lane)] = queries
    return queries_by_lane


def title_matches_target_preferences(title, lane, target_job_titles, experience_levels):
    """Require a configured role phrase and experience-level marker in the title."""
    title_key = canonicalize_title_text(title)
    if not title_key:
        return False

    configured_titles = target_job_titles.get(lane, ())
    if not configured_titles:
        return False
    role_phrases = []
    for target in configured_titles:
        target_key = canonicalize_title_text(target)
        if not target_key:
            continue
        role_phrases.append(target_key)
        for suffix, variant in _TARGET_TITLE_SUFFIX_VARIANTS.items():
            if target_key.endswith(suffix):
                role_phrases.append(target_key[: -len(suffix)] + variant)
    if role_phrases and not any(_contains_phrase(title_key, phrase) for phrase in role_phrases):
        return False

    selected_markers = tuple(
        marker for level in experience_levels for marker in EXPERIENCE_LEVEL_KEYWORDS.get(level, ())
    )
    if any(_contains_phrase(title_key, marker) for marker in selected_markers):
        return True

    if "junior" in experience_levels:
        return any(
            re.search(rf"{re.escape(role_phrase)}\s+(?:i|1)(?![a-z0-9])", title_key)
            for role_phrase in role_phrases
        )
    return not selected_markers
