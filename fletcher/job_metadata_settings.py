from __future__ import annotations

import json
from pathlib import Path

DEFAULT_JOB_METADATA_ROLE_FAMILIES = (
    "software",
    "data",
    "pm",
    "infrastructure",
    "firmware",
    "general",
    "unknown",
)
DEFAULT_JOB_METADATA_JOB_LEVELS = (
    "intern",
    "new_grad",
    "junior",
    "mid",
    "senior",
    "staff",
    "principal",
    "manager",
    "director",
    "executive",
    "unknown",
)
C2_TARGET_LANE_POLICY = (
    "Continue for jobs that match the configured resume/search lane. "
    "Reject only when the posting is clearly outside that lane."
)
C2_UNSUPPORTED_TARGET_EXAMPLES = (
    "non-computer civil engineering",
    "non-computer mechanical engineering",
    "non-computer chemical or process engineering",
    "municipal infrastructure",
    "CAD drafting",
)
C2_BLOCKED_KEYWORDS = (
    "android studio",
    "xcode",
    "vs code",
    "vscode",
    "visual studio code",
    "visual studio",
    "intellij",
    "intellij idea",
    "pycharm",
    "webstorm",
    "phpstorm",
    "rubymine",
    "clion",
    "rider",
    "eclipse",
    "netbeans",
    "sublime text",
    "atom",
    "vim",
    "neovim",
    "emacs",
)
C2_KEYWORD_KEEP_POLICY = (
    "Keep role-relevant resume bullet keywords from the job description, including concrete "
    "skills, tools, methods, platforms, domain-relevant work traits, and short capability phrases."
)
C2_KEYWORD_IGNORE_POLICY = (
    "Ignore job titles, role labels, seniority, employment type, company names, locations, "
    "compensation, hiring logistics, full sentences, vague nouns, and blocked keywords."
)
C2_SUMMARY_KEYWORD_POLICY = (
    "Pick only exact candidate keywords that improve resume-level positioning for this job. "
    "Skip job titles, degrees, majors, role labels, awkward domain claims, and pure stuffing."
)
C2_SKILL_ADDITION_POLICY = (
    "Good additions are concrete skills that fit one existing resume skill category, such as "
    "tools, methods, platforms, libraries, databases, operating systems, protocols, or short "
    "capability phrases. Ignore job titles, qualities, responsibilities, degrees, majors, "
    "disciplines, logistics, business-domain phrases, vague concepts, and blocked keywords."
)
C2_SUMMARY_GOOD_EXAMPLE = (
    "Candidate with delivery experience across production systems, automation, and "
    "cross-functional feedback loops."
)
C2_SUMMARY_BANNED_PHRASES = (
    "motivated",
    "eager",
    "passionate",
    "aspiring",
    "seeking to apply",
    "excited to",
    "looking to",
    "hoping to",
)
C2_REWRITE_EXAMPLES = (
    "Prefer additive related phrasing only when coherent. Avoid unnatural slash pairs or false pairings."
)
C2_DEFAULT_TARGET_TITLE = "Target Role"
C2_KEYWORD_SELECTION_MAX_KEYWORDS = 30
C2_KEYWORD_SELECTION_MIN_WORDS = 1
C2_KEYWORD_SELECTION_MAX_WORDS = 3
C2_JOB_METADATA_PROMPT_MAX_CHARS = 3000
C2_JOB_METADATA_MIN_CONFIDENCE = 0.8
C2_SKILL_ADDITION_LIMIT = 3

JOB_METADATA_SETTINGS_COMPONENT = "c2"
JOB_METADATA_ROLE_FAMILIES_KEY = "job_metadata_role_families"
JOB_METADATA_JOB_LEVELS_KEY = "job_metadata_job_levels"
C2_TARGET_LANE_POLICY_KEY = "target_lane_policy"
C2_UNSUPPORTED_TARGET_EXAMPLES_KEY = "unsupported_target_examples"
C2_BLOCKED_KEYWORDS_KEY = "blocked_keywords"
C2_KEYWORD_KEEP_POLICY_KEY = "keyword_keep_policy"
C2_KEYWORD_IGNORE_POLICY_KEY = "keyword_ignore_policy"
C2_SUMMARY_KEYWORD_POLICY_KEY = "summary_keyword_policy"
C2_SKILL_ADDITION_POLICY_KEY = "skill_addition_policy"
C2_SUMMARY_GOOD_EXAMPLE_KEY = "summary_good_example"
C2_SUMMARY_BANNED_PHRASES_KEY = "summary_banned_phrases"
C2_REWRITE_EXAMPLES_KEY = "rewrite_examples"
C2_DEFAULT_TARGET_TITLE_KEY = "default_target_title"
C2_KEYWORD_SELECTION_MAX_KEYWORDS_KEY = "keyword_selection_max_keywords"
C2_KEYWORD_SELECTION_MIN_WORDS_KEY = "keyword_selection_min_words"
C2_KEYWORD_SELECTION_MAX_WORDS_KEY = "keyword_selection_max_words"
C2_JOB_METADATA_PROMPT_MAX_CHARS_KEY = "job_metadata_prompt_max_chars"
C2_JOB_METADATA_MIN_CONFIDENCE_KEY = "job_metadata_min_confidence"
C2_SKILL_ADDITION_LIMIT_KEY = "skill_addition_limit"


def _clean_values(values: list[str], defaults: tuple[str, ...]) -> list[str]:
    seen: set[str] = set()
    cleaned: list[str] = []
    for value in values:
        item = str(value or "").strip().lower()
        if item and item not in seen:
            seen.add(item)
            cleaned.append(item)
    return cleaned or list(defaults)


def parse_setting_values(value: str | None, defaults: tuple[str, ...]) -> list[str]:
    raw = (value or "").strip()
    if not raw:
        return list(defaults)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, list):
        return _clean_values([str(item) for item in parsed], defaults)
    return _clean_values(raw.replace(",", "\n").splitlines(), defaults)


def parse_setting_text(value: str | None, default: str) -> str:
    raw = (value or "").strip()
    return raw or default


def parse_setting_int(value: str | None, default: int, *, minimum: int | None = None) -> int:
    raw = (value or "").strip()
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        return default
    if minimum is not None and parsed < minimum:
        return default
    return parsed


def parse_setting_float(value: str | None, default: float, *, minimum: float | None = None) -> float:
    raw = (value or "").strip()
    try:
        parsed = float(raw)
    except (TypeError, ValueError):
        return default
    if minimum is not None and parsed < minimum:
        return default
    return parsed


def load_job_metadata_settings(db_path: str | Path | None = None) -> dict[str, list[str]]:
    settings = {
        "role_families": list(DEFAULT_JOB_METADATA_ROLE_FAMILIES),
        "job_levels": list(DEFAULT_JOB_METADATA_JOB_LEVELS),
    }
    try:
        from .db import get_connection

        conn = get_connection(db_path)
        try:
            rows = conn.execute(
                """
                SELECT key, value
                FROM component_settings
                WHERE component = ? AND key IN (?, ?)
                """,
                (
                    JOB_METADATA_SETTINGS_COMPONENT,
                    JOB_METADATA_ROLE_FAMILIES_KEY,
                    JOB_METADATA_JOB_LEVELS_KEY,
                ),
            ).fetchall()
        finally:
            conn.close()
    except Exception:
        return settings

    values = {str(row["key"]): row["value"] for row in rows}
    settings["role_families"] = parse_setting_values(
        values.get(JOB_METADATA_ROLE_FAMILIES_KEY),
        DEFAULT_JOB_METADATA_ROLE_FAMILIES,
    )
    settings["job_levels"] = parse_setting_values(
        values.get(JOB_METADATA_JOB_LEVELS_KEY),
        DEFAULT_JOB_METADATA_JOB_LEVELS,
    )
    return settings


def _load_component_values(keys: tuple[str, ...], db_path: str | Path | None = None) -> dict[str, str]:
    try:
        from .db import get_connection

        conn = get_connection(db_path)
        try:
            placeholders = ",".join("?" for _ in keys)
            rows = conn.execute(
                f"""
                SELECT key, value
                FROM component_settings
                WHERE component = ? AND key IN ({placeholders})
                """,
                (JOB_METADATA_SETTINGS_COMPONENT, *keys),
            ).fetchall()
        finally:
            conn.close()
    except Exception:
        return {}
    return {str(row["key"]): str(row["value"] or "") for row in rows}


def load_c2_prompt_settings(db_path: str | Path | None = None) -> dict[str, object]:
    keys = (
        JOB_METADATA_ROLE_FAMILIES_KEY,
        JOB_METADATA_JOB_LEVELS_KEY,
        C2_TARGET_LANE_POLICY_KEY,
        C2_UNSUPPORTED_TARGET_EXAMPLES_KEY,
        C2_BLOCKED_KEYWORDS_KEY,
        C2_KEYWORD_KEEP_POLICY_KEY,
        C2_KEYWORD_IGNORE_POLICY_KEY,
        C2_SUMMARY_KEYWORD_POLICY_KEY,
        C2_SKILL_ADDITION_POLICY_KEY,
        C2_SUMMARY_GOOD_EXAMPLE_KEY,
        C2_SUMMARY_BANNED_PHRASES_KEY,
        C2_REWRITE_EXAMPLES_KEY,
        C2_DEFAULT_TARGET_TITLE_KEY,
        C2_KEYWORD_SELECTION_MAX_KEYWORDS_KEY,
        C2_KEYWORD_SELECTION_MIN_WORDS_KEY,
        C2_KEYWORD_SELECTION_MAX_WORDS_KEY,
        C2_JOB_METADATA_PROMPT_MAX_CHARS_KEY,
        C2_JOB_METADATA_MIN_CONFIDENCE_KEY,
        C2_SKILL_ADDITION_LIMIT_KEY,
    )
    values = _load_component_values(keys, db_path)
    return {
        "role_families": parse_setting_values(
            values.get(JOB_METADATA_ROLE_FAMILIES_KEY),
            DEFAULT_JOB_METADATA_ROLE_FAMILIES,
        ),
        "job_levels": parse_setting_values(
            values.get(JOB_METADATA_JOB_LEVELS_KEY),
            DEFAULT_JOB_METADATA_JOB_LEVELS,
        ),
        "target_lane_policy": parse_setting_text(
            values.get(C2_TARGET_LANE_POLICY_KEY), C2_TARGET_LANE_POLICY
        ),
        "unsupported_target_examples": parse_setting_values(
            values.get(C2_UNSUPPORTED_TARGET_EXAMPLES_KEY),
            C2_UNSUPPORTED_TARGET_EXAMPLES,
        ),
        "blocked_keywords": parse_setting_values(
            values.get(C2_BLOCKED_KEYWORDS_KEY), C2_BLOCKED_KEYWORDS
        ),
        "keyword_keep_policy": parse_setting_text(
            values.get(C2_KEYWORD_KEEP_POLICY_KEY), C2_KEYWORD_KEEP_POLICY
        ),
        "keyword_ignore_policy": parse_setting_text(
            values.get(C2_KEYWORD_IGNORE_POLICY_KEY), C2_KEYWORD_IGNORE_POLICY
        ),
        "summary_keyword_policy": parse_setting_text(
            values.get(C2_SUMMARY_KEYWORD_POLICY_KEY), C2_SUMMARY_KEYWORD_POLICY
        ),
        "skill_addition_policy": parse_setting_text(
            values.get(C2_SKILL_ADDITION_POLICY_KEY), C2_SKILL_ADDITION_POLICY
        ),
        "summary_good_example": parse_setting_text(
            values.get(C2_SUMMARY_GOOD_EXAMPLE_KEY), C2_SUMMARY_GOOD_EXAMPLE
        ),
        "summary_banned_phrases": parse_setting_values(
            values.get(C2_SUMMARY_BANNED_PHRASES_KEY), C2_SUMMARY_BANNED_PHRASES
        ),
        "rewrite_examples": parse_setting_text(
            values.get(C2_REWRITE_EXAMPLES_KEY), C2_REWRITE_EXAMPLES
        ),
        "default_target_title": parse_setting_text(
            values.get(C2_DEFAULT_TARGET_TITLE_KEY), C2_DEFAULT_TARGET_TITLE
        ),
        "keyword_selection_max_keywords": parse_setting_int(
            values.get(C2_KEYWORD_SELECTION_MAX_KEYWORDS_KEY),
            C2_KEYWORD_SELECTION_MAX_KEYWORDS,
            minimum=0,
        ),
        "keyword_selection_min_words": parse_setting_int(
            values.get(C2_KEYWORD_SELECTION_MIN_WORDS_KEY),
            C2_KEYWORD_SELECTION_MIN_WORDS,
            minimum=0,
        ),
        "keyword_selection_max_words": parse_setting_int(
            values.get(C2_KEYWORD_SELECTION_MAX_WORDS_KEY),
            C2_KEYWORD_SELECTION_MAX_WORDS,
            minimum=1,
        ),
        "job_metadata_prompt_max_chars": parse_setting_int(
            values.get(C2_JOB_METADATA_PROMPT_MAX_CHARS_KEY),
            C2_JOB_METADATA_PROMPT_MAX_CHARS,
            minimum=1,
        ),
        "job_metadata_min_confidence": parse_setting_float(
            values.get(C2_JOB_METADATA_MIN_CONFIDENCE_KEY),
            C2_JOB_METADATA_MIN_CONFIDENCE,
            minimum=0.0,
        ),
        "skill_addition_limit": parse_setting_int(
            values.get(C2_SKILL_ADDITION_LIMIT_KEY),
            C2_SKILL_ADDITION_LIMIT,
            minimum=0,
        ),
    }
