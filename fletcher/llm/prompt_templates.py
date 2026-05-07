from __future__ import annotations

import json
import re
from typing import Any

from ..job_metadata_settings import (
    C2_CANDIDATE_CONTEXT_PROMPT_MAX_CHARS,
    C2_JD_EXCERPT_HEAD_DIVISOR,
    C2_JD_EXCERPT_HEAD_MIN_CHARS,
    C2_JD_EXCERPT_MARKER_PREFIX_CHARS,
    C2_JD_EXCERPT_MARKER_SUFFIX_CHARS,
    C2_JD_EXCERPT_MIN_CHARS,
    C2_JD_EXCERPT_SEPARATOR_BUDGET,
    C2_JD_EXCERPT_TAIL_DIVISOR,
    C2_JD_EXCERPT_TAIL_MIN_CHARS,
    C2_JOB_METADATA_MIN_CONFIDENCE,
    C2_JOB_METADATA_PROMPT_MAX_CHARS,
    C2_KEYWORD_EXTRACT_PROMPT_MAX_CHARS,
    C2_KEYWORD_IGNORE_POLICY,
    C2_KEYWORD_KEEP_POLICY,
    C2_KEYWORD_SELECTION_MAX_KEYWORDS,
    C2_KEYWORD_SELECTION_MAX_WORDS,
    C2_KEYWORD_SELECTION_MIN_WORDS,
    C2_LOW_RAG_PROMPT_MAX_CHARS,
    C2_REWRITE_ACTION_KEYWORD_POLICY,
    C2_REWRITE_BULLET_POLICY,
    C2_REWRITE_KEYWORD_FIT_POLICY,
    C2_REWRITE_LENGTH_POLICY,
    C2_REWRITE_MAX_LENGTH_INCREASE_PERCENT,
    C2_REWRITE_STRATEGY,
    C2_SKILL_ADDITION_POLICY,
    C2_SUMMARY_BANNED_PHRASES,
    C2_SUMMARY_GOOD_EXAMPLE,
    C2_SUMMARY_KEYWORD_LIMIT,
    C2_SUMMARY_KEYWORD_POLICY,
    C2_SUMMARY_SENTENCE_RANGE,
    C2_SUMMARY_TARGET_PRINTED_LINES,
    C2_SUMMARY_VALIDATION_REASON_LIMIT_TEXT,
    C2_SUMMARY_VALIDATION_REASON_MAX_CHARS,
    C2_SUMMARY_WORD_RANGE,
)

OLLAMA_SYSTEM_PROMPT = (
    "You are a careful resume-tailoring assistant. "
    "Return strict JSON only, follow the requested schema exactly, "
    "skip awkward or incoherent additions over guessing,"
    " DO NOT Make up any information with no evidence."
)


def join_values(values: list[str]) -> str:
    return ", ".join(str(value).strip() for value in values if str(value).strip())


def prompt_json(value: Any) -> str:
    return json.dumps(value)


def empty_text(value: str) -> str:
    return value or "(empty)"


def candidate_context_excerpt(value: str) -> str:
    return (value or "")[:C2_CANDIDATE_CONTEXT_PROMPT_MAX_CHARS]


def unsupported_examples_line(values: list[str] | None) -> str:
    examples = values or []
    return (
        f"Unsupported examples from workflow policy: {join_values(examples)}.\n" if examples else ""
    )


def optional_text_block(label: str, value: str) -> str:
    text = (value or "").strip()
    return f"{label}:\n{text}\n" if text else ""


def build_jd_prompt_excerpt(description: str, max_chars: int) -> str:
    """Build a compact job description excerpt without blindly dropping the end of long postings."""
    text = re.sub(r"\r\n?", "\n", (description or "").strip())
    if not text or len(text) <= max_chars:
        return text

    max_chars = max(C2_JD_EXCERPT_MIN_CHARS, int(max_chars))
    head_budget = max(C2_JD_EXCERPT_HEAD_MIN_CHARS, max_chars // C2_JD_EXCERPT_HEAD_DIVISOR)
    tail_budget = max(C2_JD_EXCERPT_TAIL_MIN_CHARS, max_chars // C2_JD_EXCERPT_TAIL_DIVISOR)
    section_budget = max_chars - head_budget - tail_budget - C2_JD_EXCERPT_SEPARATOR_BUDGET
    section_markers = re.compile(
        r"(?im)^(.*(?:about the role|role overview|responsibilities|duties|"
        r"requirements|qualifications|required|skills|experience|what you).*)$"
    )

    chunks: list[str] = [text[:head_budget].strip()]
    used_section_chars = 0
    for match in section_markers.finditer(text):
        if used_section_chars >= section_budget:
            break
        window_start = max(0, match.start() - C2_JD_EXCERPT_MARKER_PREFIX_CHARS)
        window_end = min(len(text), match.end() + C2_JD_EXCERPT_MARKER_SUFFIX_CHARS)
        chunk = text[window_start:window_end].strip()
        if not chunk or chunk in chunks:
            continue
        remaining = section_budget - used_section_chars
        section_chunk = chunk[:remaining].strip()
        chunks.append(section_chunk)
        used_section_chars += len(section_chunk)

    tail = text[-tail_budget:].strip()
    if tail and tail not in chunks:
        chunks.append(tail)

    excerpt = "\n\n[...]\n\n".join(chunk for chunk in chunks if chunk)
    return excerpt[:max_chars].strip()


def keyword_selection_prompt(
    *,
    max_keywords: int = C2_KEYWORD_SELECTION_MAX_KEYWORDS,
    min_words: int = C2_KEYWORD_SELECTION_MIN_WORDS,
    max_words: int = C2_KEYWORD_SELECTION_MAX_WORDS,
    min_confidence: float = C2_JOB_METADATA_MIN_CONFIDENCE,
    keep_policy: str = C2_KEYWORD_KEEP_POLICY,
    ignore_policy: str = C2_KEYWORD_IGNORE_POLICY,
) -> str:
    return f"""Extract 0 to {max_keywords} resume bullet keywords that appear in the description.

Keep policy:
{keep_policy}

Ignore policy:
{ignore_policy}

Never return the actual job title, role title, seniority label, employment type, degree, or major as a keyword.
Every keyword must be {min_words} to {max_words} words. If you are not {min_confidence:g} confident a term fits the keep policy, skip it. Quality over quantity.
Use exact job description wording. Do not invent terms. If description is unusable, i.e. no usable keywords for the job title then keywords must be []."""


def build_keyword_extract_prompt(
    title: str,
    description: str,
    *,
    role_family: str = "",
    job_level: str = "",
    max_keywords: int = C2_KEYWORD_SELECTION_MAX_KEYWORDS,
    min_words: int = C2_KEYWORD_SELECTION_MIN_WORDS,
    max_words: int = C2_KEYWORD_SELECTION_MAX_WORDS,
    min_confidence: float = C2_JOB_METADATA_MIN_CONFIDENCE,
    keep_policy: str = C2_KEYWORD_KEEP_POLICY,
    ignore_policy: str = C2_KEYWORD_IGNORE_POLICY,
) -> str:
    excerpt = build_jd_prompt_excerpt(description, C2_KEYWORD_EXTRACT_PROMPT_MAX_CHARS)
    role_context = ""
    if role_family or job_level:
        role_context = (
            "Role context, for keyword context only: "
            f"role_family={role_family or '(empty)'}, job_level={job_level or '(empty)'}.\n"
        )
    return (
        "Extract resume-tailoring keywords from this job description.\n"
        f"Job title: {empty_text(title)}\n"
        f"{role_context}"
        f"Job description excerpt:\n{empty_text(excerpt)}\n\n"
        f"{keyword_selection_prompt(max_keywords=max_keywords, min_words=min_words, max_words=max_words, min_confidence=min_confidence, keep_policy=keep_policy, ignore_policy=ignore_policy)}\n\n"
        'Only accepted answer format: {"keywords": ["..."]}. No markdown. No prose. No extra keys.'
    )


def build_job_metadata_prompt(
    *,
    input_title: str,
    description: str,
    missing_fields: list[str],
    role_family_values: list[str],
    job_level_values: list[str],
    max_chars: int = C2_JOB_METADATA_PROMPT_MAX_CHARS,
    min_confidence: float = C2_JOB_METADATA_MIN_CONFIDENCE,
    target_lane_policy: str = "",
    unsupported_examples: list[str] | None = None,
) -> str:
    target_lane_policy = (target_lane_policy or "").strip()
    unsupported_examples = unsupported_examples or []
    description_excerpt = (description or "").strip()[:max_chars]
    lane_line = (
        f"Target-lane policy: {target_lane_policy}\n"
        if target_lane_policy
        else "No target-lane policy was supplied. Do not judge whether this job belongs to a configured search lane.\n"
    )
    if target_lane_policy and unsupported_examples:
        lane_line += unsupported_examples_line(unsupported_examples)
    return (
        "Fill missing job metadata from the job description.\n"
        f"Input title: {empty_text(input_title)}\n"
        f"Missing fields to fill: {join_values(missing_fields) or '(none)'}\n"
        f"Job description excerpt:\n{empty_text(description_excerpt)}\n"
        f"{lane_line}"
        f"Only fill a field when you are at least {min_confidence:g} confident. "
        "If not at least that confident, return an empty string for text fields and false for unsupported_target_role. "
        "Do not invent a title, role family, or level from vague text. "
        f"Use only these role_family values: {join_values(role_family_values)}. "
        f"Use only these job_level values: {join_values(job_level_values)}. "
        "Set jd_usable=false only when the description is empty, a stub, or lacks enough concrete content for tailoring. "
        "Set mismatch=true only for a clear conflict between the input title and the actual job title. "
        "Set unsupported_target_role=true only when a target-lane policy is supplied and the job clearly violates it.\n"
        'Only accepted answer format: {"title": "...", "role_family": "...", "job_level": "...", "mismatch": boolean, "mismatch_reason": "...", "unsupported_target_role": boolean, "unsupported_target_reason": "...", "confidence": 0.0, "jd_usable": boolean, "jd_usable_reason": "..."}. No markdown. No prose. No extra keys.'
    )


def build_summary_keyword_filter_prompt(
    *,
    keywords: list[str],
    candidate_context: str,
    job_title: str,
    summary_keyword_policy: str = C2_SUMMARY_KEYWORD_POLICY,
    retry: bool = False,
) -> str:
    retry_line = (
        "Previous output used terms outside Candidate keywords. Use only exact items from Candidate keywords.\n"
        if retry
        else ""
    )
    return (
        "Pick keywords to add to resume summary.\n"
        f"Job title: {empty_text(job_title)}\n"
        f"Candidate evidence: {candidate_context_excerpt(candidate_context)}\n"
        f"Candidate keywords: {prompt_json(keywords)}\n"
        f"{retry_line}"
        f"Summary keyword policy: {summary_keyword_policy} "
        f"Include 0 to {C2_SUMMARY_KEYWORD_LIMIT} exact Candidate keywords. "
        "Fewer is better when extra keywords make summary worse. Do not create synonyms or new terms that is not in the Candidate keywords.\n"
        'Only accepted answer format: {"included": ["..."], "excluded": ["..."], "reason": "..."}. No markdown. No prose. No extra keys.'
    )


def build_skill_bucket_prompt(
    *,
    keywords: list[str],
    existing_skills: dict[str, list[str]],
    skill_addition_limit: int,
    job_title: str = "",
    min_confidence: float = C2_JOB_METADATA_MIN_CONFIDENCE,
    skill_addition_policy: str = C2_SKILL_ADDITION_POLICY,
    retry: bool = False,
) -> str:
    categories = [str(category).strip() for category in existing_skills if str(category).strip()]
    category_list = join_values(categories)
    retry_line = (
        "Previous output was invalid. Return additions as an object and ignored as an array, and use only exact Candidate keywords.\n"
        if retry
        else ""
    )
    return (
        "Pick skills to add to my resume Technical Skills.\n"
        f"Job title: {empty_text(job_title)}\n"
        f"Existing skills: {prompt_json(existing_skills)}\n"
        f"Candidate keywords: {prompt_json(keywords)}\n"
        f"{retry_line}"
        f"Choose 0 to {skill_addition_limit} total additions. Pick only from Candidate keywords. "
        "Only add a keyword if it is relevant to one specific Existing skills category and is not effectively the same as an existing skill. "
        f"Skill addition policy: {skill_addition_policy} "
        f"If not {min_confidence:g} sure, ignore the keyword. "
        f"Category must be exactly one of the existing categories: {category_list}.\n"
        'Only accepted answer format: {"additions": {"keyword one": "category", "keyword two": "category"}, "ignored": ["..."]}. Additions is an object of keyword-to-category pairs. No markdown. No prose. No extra keys.'
    )


def build_low_rag_unsupported_target_prompt(
    *,
    title: str,
    description: str,
    keywords: list[str],
    compact_scores: list[dict[str, Any]],
    target_lane_policy: str = "",
    unsupported_examples: list[str] | None = None,
) -> str:
    target_lane_policy = (target_lane_policy or "").strip()
    if not target_lane_policy:
        raise ValueError("target_lane_policy is required for low-RAG unsupported-target prompt")
    unsupported_examples = unsupported_examples or []
    lane_line = f"Target-lane policy: {target_lane_policy}\n"
    if unsupported_examples:
        lane_line += unsupported_examples_line(unsupported_examples)
    policy_line = "Set unsupported_target_role=true only when the posting clearly violates the supplied target-lane policy.\n"

    return (
        "Check whether a queued job is outside the target lane after RAG found very few high-confidence matches between the job description keywords and the stored resume.\n"
        "This check is only for queued jobs already stored in the workflow. Apply supplied workflow policy only; do not decide whether tailoring should continue and do not judge whether every keyword is visibly proven by the resume.\n"
        f"{lane_line}"
        f"{policy_line}"
        f"Job title: {empty_text(title)}\n"
        f"Job description excerpt: {empty_text(build_jd_prompt_excerpt(description, C2_LOW_RAG_PROMPT_MAX_CHARS))}\n"
        f"Extracted keywords: {prompt_json(keywords)}\n"
        f"RAG keyword tiers: {prompt_json(compact_scores)}\n"
        'Return only: {"unsupported_target_role": boolean, "reason": "..."}'
    )


def build_summary_validation_prompt(
    *,
    summary: str,
    candidate_context: str,
    keywords: list[str],
    summary_banned_phrases: list[str] | None = None,
) -> str:
    summary_banned_phrases = summary_banned_phrases or list(C2_SUMMARY_BANNED_PHRASES)
    return (
        "Validate resume summary fit.\n"
        f"Candidate evidence: {candidate_context_excerpt(candidate_context)}\n"
        f"Requested keywords: {prompt_json(keywords)}\n"
        f"Summary: {summary}\n"
        "Accept only if summary is coherent, polished, and positioned for this candidate. "
        "Reject awkward keyword stuffing, copied bullet phrasing, forced domain/tool claims, obvious exaggeration, or banned filler tone. "
        f"Banned phrases: {join_values(summary_banned_phrases)}. "
        "Do not reject because unused keywords exist, we rather have unused keywords than use them badly. "
        f"Keep each reason under {C2_SUMMARY_VALIDATION_REASON_MAX_CHARS} characters, can have {C2_SUMMARY_VALIDATION_REASON_LIMIT_TEXT} reason\n"
        'Only accepted answer format: {"accepted": boolean, "reasons": ["..."]}. No markdown. No prose. No extra keys.'
    )


def build_summary_generation_prompt(
    *,
    candidate_context: str,
    job_title: str,
    keywords: list[str],
    existing_summary: str = "",
    line_feedback: str = "",
    role_family: str = "",
    job_level: str = "",
    summary_good_example: str = C2_SUMMARY_GOOD_EXAMPLE,
    summary_banned_phrases: list[str] | None = None,
) -> str:
    summary_banned_phrases = summary_banned_phrases or list(C2_SUMMARY_BANNED_PHRASES)
    summary_keywords = []
    seen: set[str] = set()
    for keyword in keywords:
        item = str(keyword).strip()
        key = item.lower()
        if item and key not in seen:
            seen.add(key)
            summary_keywords.append(item)
    kw_list = ", ".join(summary_keywords) if summary_keywords else ""
    kw_line = (
        f"Optional job description keywords, max {C2_SUMMARY_KEYWORD_LIMIT} if natural:\n{kw_list}\n"
        if kw_list
        else ""
    )
    existing_line = optional_text_block("Existing resume summary for context", existing_summary)
    feedback_line = optional_text_block("Retry/length feedback to address", line_feedback)
    role_key = (role_family or "").strip().lower() or "unknown"
    level_key = (job_level or "").strip().lower() or "unknown"
    role_instruction = (
        f"Target role context: title={job_title}, role_family={role_key}, level={level_key}. "
        "Position the candidate for the exact job title and level. "
        "Tailor positioning to that context without claiming unsupported domain experience. "
    )
    return (
        f"Job title: {job_title}\n"
        f"Role family: {role_key}\n"
        f"Job level: {level_key}\n"
        f"{kw_line}"
        f"{existing_line}"
        f"{feedback_line}"
        f"Candidate background: {candidate_context}\n"
        "Do not copy word for word from Candidate background.\n"
        f"Good summary example: {summary_good_example}\n"
        f"Write {C2_SUMMARY_SENTENCE_RANGE} sentence resume summary, {C2_SUMMARY_WORD_RANGE} words, aiming near {C2_SUMMARY_TARGET_PRINTED_LINES} printed lines. "
        "Summary should paraphrase candidate background and add in keywords where we can instead of only copying it"
        "Start with candidate facts and skills, then job fit. "
        f"{role_instruction}"
        f"No fillers and dont use bloat like: {join_values(summary_banned_phrases)}. "
        "Do not use banned phrases or variants. State what the candidate does, not what they want. "
        "Do not imply direct domain experience unless it fits the job, we aim for good flow over truthfulness of the candidate's abilities. "
        "If strong targeted summary does not fit, return empty summary.\n"
        'Only accepted answer format: {"summary": "...", "keywords_used": ["..."], "keyword_use_reason": "...", "retry_reason": "..."}. '
        "keywords_used must list exact job description keywords used in summary if any. "
        "keyword_use_reason must briefly say why those keywords were used, no reason if none. "
        "retry_reason must be empty unless Retry/length feedback exists; if retrying, say what style issue was fixed. "
        "No markdown. No prose. No extra keys."
    )


def _setting_text(value: str, default: str) -> str:
    return (value or default).strip()


def _rewrite_length_policy_text(value: str) -> str:
    return _setting_text(value, C2_REWRITE_LENGTH_POLICY).replace(
        "{max_length_percent}", str(C2_REWRITE_MAX_LENGTH_INCREASE_PERCENT)
    )


def build_validate_rewrite_prompt(
    *,
    original: str,
    rewritten: str,
    requested_keywords: list[str],
    rewrite_keyword_fit_policy: str = C2_REWRITE_KEYWORD_FIT_POLICY,
    rewrite_bullet_policy: str = C2_REWRITE_BULLET_POLICY,
    rewrite_length_policy: str = C2_REWRITE_LENGTH_POLICY,
    rewrite_action_keyword_policy: str = C2_REWRITE_ACTION_KEYWORD_POLICY,
) -> str:
    rewrite_keyword_fit_policy = _setting_text(
        rewrite_keyword_fit_policy, C2_REWRITE_KEYWORD_FIT_POLICY
    )
    rewrite_bullet_policy = _setting_text(rewrite_bullet_policy, C2_REWRITE_BULLET_POLICY)
    rewrite_action_keyword_policy = _setting_text(
        rewrite_action_keyword_policy, C2_REWRITE_ACTION_KEYWORD_POLICY
    )
    return (
        "Validate whether a rewritten resume bullet preserves the original meaning while adding resume keywords that still make sense.\n"
        f"Original bullet: {original}\n"
        f"Rewritten bullet: {rewritten}\n"
        f"Requested keywords: {', '.join(requested_keywords)}\n"
        "Keyword fit policy:\n"
        f"{rewrite_keyword_fit_policy}\n"
        "- Set accepted=true only when the bullet preserves meaning, reads naturally, and supports at least one requested keyword.\n"
        "Bullet rewrite policy:\n"
        f"{rewrite_bullet_policy}\n"
        "Action keyword policy:\n"
        f"{rewrite_action_keyword_policy}\n"
        "Put supported keywords in keywords_supported and unsupported keywords in "
        "keywords_rejected.\n"
        'Return only: {"accepted": boolean, "keywords_supported": [...], '
        '"keywords_rejected": [...], "reason": "..."}'
    )


def build_rewrite_bullet_prompt(
    *,
    bullet: str,
    keywords: list[str],
    keywords_to_preserve: list[str] | None = None,
    rewrite_strategy: str = C2_REWRITE_STRATEGY,
    rewrite_keyword_fit_policy: str = C2_REWRITE_KEYWORD_FIT_POLICY,
    rewrite_bullet_policy: str = C2_REWRITE_BULLET_POLICY,
    rewrite_length_policy: str = C2_REWRITE_LENGTH_POLICY,
    rewrite_action_keyword_policy: str = C2_REWRITE_ACTION_KEYWORD_POLICY,
) -> str:
    kw_list = ", ".join(keywords)
    preserve_line = ""
    if keywords_to_preserve:
        preserve_line = (
            f"Keywords already in this bullet that must stay: {', '.join(keywords_to_preserve)}.\n"
        )
    rewrite_strategy = _setting_text(rewrite_strategy, C2_REWRITE_STRATEGY)
    rewrite_keyword_fit_policy = _setting_text(
        rewrite_keyword_fit_policy, C2_REWRITE_KEYWORD_FIT_POLICY
    )
    rewrite_bullet_policy = _setting_text(rewrite_bullet_policy, C2_REWRITE_BULLET_POLICY)
    rewrite_length_policy = _rewrite_length_policy_text(rewrite_length_policy)
    rewrite_action_keyword_policy = _setting_text(
        rewrite_action_keyword_policy, C2_REWRITE_ACTION_KEYWORD_POLICY
    )
    return (
        f"Rewrite this resume bullet to naturally weave in these keywords only where they fit cleanly: {kw_list}\n"
        f"{preserve_line}"
        "Fit and readability matter more than keyword coverage. If there is more than one keyword, you do not need to fit all of them.\n"
        "Skip any keyword that would make the bullet awkward, vague, or less believable.\n"
        "Keyword fit policy:\n"
        f"{rewrite_keyword_fit_policy}\n"
        "Bullet rewrite policy:\n"
        f"{rewrite_bullet_policy}\n"
        f"{rewrite_length_policy}\n"
        "Action keyword policy:\n"
        f"{rewrite_action_keyword_policy}\n"
        f"Rewrite strategy:\n{rewrite_strategy}\n"
        f"Bullet: {bullet.strip()}\n"
        'Return only: {"bullet": "...", "keywords_used": [...], "keywords_skipped": [...]}'
    )
