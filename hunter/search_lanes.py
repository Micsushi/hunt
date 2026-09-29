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
        "it support",
        "technical support",
        "help desk",
        "service desk",
        "desktop support",
        "application support",
        "systems administrator",
        "system administrator",
        "network administrator",
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

    keywords = LANE_TITLE_KEYWORDS.get(lane)
    if not keywords:
        return True

    title_key = canonicalize_title_text(title)
    if lane == LANE_PRODUCT and _PM_TOKEN.search(title_key):
        return True
    return any(keyword in title_key for keyword in keywords)
