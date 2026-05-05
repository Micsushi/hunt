from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Literal


class KeywordKind(StrEnum):
    TECH = "tech"
    TOOL = "tool"
    LANGUAGE = "language"
    FRAMEWORK = "framework"
    PROCESS = "process"
    QUALITY = "quality"
    DOMAIN = "domain"
    ROLE_TITLE = "role_title"
    EDUCATION = "education"
    LOGISTICS = "logistics"
    ORG_METADATA = "org_metadata"
    LANGUAGE_REQUIREMENT = "language_requirement"
    IGNORE = "ignore"


class KeywordRoute(StrEnum):
    REWRITE = "rewrite"
    SUMMARY = "summary"
    SKILLS_ONLY = "skills_only"
    IGNORE = "ignore"


@dataclass(frozen=True)
class KeywordPolicy:
    keyword: str
    kind: KeywordKind
    route: Literal["rewrite", "summary", "skills_only", "ignore"]
    allow_bullet_rewrite: bool
    allow_summary: bool
    requires_same_bullet_evidence: bool
    allow_same_category_tool_substitution: bool
    min_confidence: float = 0.70
    reason: str = ""


_ROLE_WORDS = {
    "analyst",
    "consultant",
    "developer",
    "engineer",
    "intern",
    "manager",
    "owner",
    "scientist",
}

_EDUCATION_TERMS = {
    "business intelligence",
    "computer engineering",
    "computer science",
    "mathematics",
    "software engineering",
}

_ORG_METADATA_TERMS = {
    "ceo",
    "china-based team",
    "china based team",
    "growth team",
    "mbb",
    "vp of growth",
}

_LANGUAGE_REQUIREMENTS = {
    "chinese",
    "french",
    "mandarin",
    "spanish",
}

_DOMAIN_TERMS = {
    "ai-driven platform",
    "ai powered super app",
    "ai-powered super app",
    "car ownership",
    "cybersecurity",
    "funnel analysis",
    "funnels",
    "geometrical planning",
    "insurance",
    "itdr",
    "mdr",
    "real-time threat intelligence",
    "robotics",
    "siem",
    "threat intelligence",
    "xdr",
}

_PROCESS_TERMS = {
    "a/b testing",
    "agile",
    "bug triage",
    "ci/cd",
    "code reviews",
    "end-to-end",
    "full life cycle development",
    "git",
    "scrum",
    "source control",
    "source repository processes",
    "testing",
    "unit",
    "unit testing",
}

_QUALITY_TERMS = {
    "analytical thinking",
    "collaboration",
    "communication",
    "customer empathy",
    "leadership",
    "ownership",
    "proactive",
    "proactive communication",
    "stakeholder alignment",
    "structured problem solving",
    "structured thinker",
    "user experience",
}

_TOOLS = {
    "aws",
    "azure devops",
    "bitbucket",
    "bitbucket pipelines",
    "confluence",
    "databricks",
    "datadog",
    "docker",
    "dynamodb",
    "ecr",
    "git",
    "jira",
    "kubernetes",
    "mongodb",
    "postgresql",
    "power bi",
    "s3",
    "snowflake",
    "supabase",
    "terraform",
    "vercel",
}

_LANGUAGES = {
    "bash",
    "c#",
    "c++",
    "java",
    "javascript",
    "kotlin",
    "pl/sql",
    "python",
    "r",
    "sql",
    "typescript",
}

_FRAMEWORKS = {
    "express.js",
    "fastapi",
    "flask",
    "next.js",
    "node.js",
    "react",
    "tailwind",
    "vue.js",
    "wpf",
}


def normalize_keyword(keyword: str) -> str:
    value = re.sub(r"[*_`]+", "", keyword or "")
    value = re.sub(r"[^a-z0-9+#./-]+", " ", value.lower())
    return re.sub(r"\s+", " ", value).strip()


def _contains_role_shape(key: str, job_title: str) -> bool:
    words = set(key.replace("-", " ").split())
    if key == normalize_keyword(job_title):
        return True
    return bool(words & _ROLE_WORDS) and (
        "software" in words or "product" in words or "data" in words
    )


def _policy(
    keyword: str,
    kind: KeywordKind,
    route: KeywordRoute,
    *,
    requires_same_bullet_evidence: bool = False,
    allow_same_category_tool_substitution: bool = False,
    reason: str = "",
) -> KeywordPolicy:
    return KeywordPolicy(
        keyword=keyword,
        kind=kind,
        route=route.value,
        allow_bullet_rewrite=route == KeywordRoute.REWRITE,
        allow_summary=route in {KeywordRoute.REWRITE, KeywordRoute.SUMMARY},
        requires_same_bullet_evidence=requires_same_bullet_evidence,
        allow_same_category_tool_substitution=allow_same_category_tool_substitution,
        reason=reason,
    )


def classify_keyword_policy(
    keyword: str,
    *,
    job_title: str = "",
    resume_context: str = "",
) -> KeywordPolicy:
    key = normalize_keyword(keyword)
    context = normalize_keyword(resume_context)
    if not key:
        return _policy(keyword, KeywordKind.IGNORE, KeywordRoute.IGNORE, reason="empty")

    if _contains_role_shape(key, job_title):
        return _policy(keyword, KeywordKind.ROLE_TITLE, KeywordRoute.SUMMARY, reason="role_title")
    if key in _ORG_METADATA_TERMS:
        return _policy(
            keyword, KeywordKind.ORG_METADATA, KeywordRoute.IGNORE, reason="org_metadata"
        )
    if key in _LANGUAGE_REQUIREMENTS:
        route = KeywordRoute.SUMMARY if key in context else KeywordRoute.IGNORE
        return _policy(
            keyword, KeywordKind.LANGUAGE_REQUIREMENT, route, reason="language_requirement"
        )
    if key in _EDUCATION_TERMS:
        return _policy(keyword, KeywordKind.EDUCATION, KeywordRoute.SUMMARY, reason="education")
    if key in _DOMAIN_TERMS:
        return _policy(
            keyword,
            KeywordKind.DOMAIN,
            KeywordRoute.REWRITE,
            requires_same_bullet_evidence=True,
            reason="domain",
        )
    if key in _PROCESS_TERMS:
        return _policy(
            keyword,
            KeywordKind.PROCESS,
            KeywordRoute.REWRITE,
            requires_same_bullet_evidence=True,
            reason="process",
        )
    if key in _QUALITY_TERMS:
        return _policy(keyword, KeywordKind.QUALITY, KeywordRoute.REWRITE, reason="quality")
    if key in _TOOLS:
        return _policy(
            keyword,
            KeywordKind.TOOL,
            KeywordRoute.REWRITE,
            allow_same_category_tool_substitution=True,
            reason="tool",
        )
    if key in _LANGUAGES:
        return _policy(keyword, KeywordKind.LANGUAGE, KeywordRoute.REWRITE, reason="language")
    if key in _FRAMEWORKS:
        return _policy(keyword, KeywordKind.FRAMEWORK, KeywordRoute.REWRITE, reason="framework")
    if any(token in key for token in ("api", "backend", "frontend", "database", "cloud")):
        return _policy(keyword, KeywordKind.TECH, KeywordRoute.REWRITE, reason="tech_phrase")
    if any(token in key for token in ("location", "salary", "compensation", "req id")):
        return _policy(keyword, KeywordKind.LOGISTICS, KeywordRoute.IGNORE, reason="logistics")

    return _policy(keyword, KeywordKind.IGNORE, KeywordRoute.IGNORE, reason="unknown")
