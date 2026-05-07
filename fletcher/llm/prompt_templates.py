from __future__ import annotations

import json
import re
from typing import Any

from ..job_metadata_settings import (
    C2_JOB_METADATA_MIN_CONFIDENCE,
    C2_JOB_METADATA_PROMPT_MAX_CHARS,
    C2_KEYWORD_IGNORE_POLICY,
    C2_KEYWORD_KEEP_POLICY,
    C2_KEYWORD_SELECTION_MAX_KEYWORDS,
    C2_KEYWORD_SELECTION_MAX_WORDS,
    C2_KEYWORD_SELECTION_MIN_WORDS,
    C2_REWRITE_EXAMPLES,
    C2_SKILL_ADDITION_POLICY,
    C2_SUMMARY_BANNED_PHRASES,
    C2_SUMMARY_GOOD_EXAMPLE,
    C2_SUMMARY_KEYWORD_POLICY,
)

OLLAMA_SYSTEM_PROMPT = (
    "You are a careful resume-tailoring assistant. "
    "Return strict JSON only, follow the requested schema exactly, "
    "skip awkward or incoherent additions over guessing."
)

def join_values(values: list[str]) -> str:
    return ", ".join(str(value).strip() for value in values if str(value).strip())


def build_jd_prompt_excerpt(description: str, max_chars: int) -> str:
    """Build a compact job description excerpt without blindly dropping the end of long postings."""
    text = re.sub(r"\r\n?", "\n", (description or "").strip())
    if not text or len(text) <= max_chars:
        return text

    max_chars = max(800, int(max_chars))
    head_budget = max(350, max_chars // 3)
    tail_budget = max(250, max_chars // 5)
    section_budget = max_chars - head_budget - tail_budget - 80
    section_markers = re.compile(
        r"(?im)^(.*(?:about the role|role overview|responsibilities|duties|"
        r"requirements|qualifications|required|skills|experience|what you).*)$"
    )

    chunks: list[str] = [text[:head_budget].strip()]
    used_section_chars = 0
    for match in section_markers.finditer(text):
        if used_section_chars >= section_budget:
            break
        window_start = max(0, match.start() - 120)
        window_end = min(len(text), match.end() + 900)
        chunk = text[window_start:window_end].strip()
        if not chunk or chunk in chunks:
            continue
        remaining = section_budget - used_section_chars
        chunks.append(chunk[:remaining].strip())
        used_section_chars += len(chunks[-1])

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
    excerpt = build_jd_prompt_excerpt(description, 4500)
    role_context = ""
    if role_family or job_level:
        role_context = (
            "Role context, for keyword context only: "
            f"role_family={role_family or '(empty)'}, job_level={job_level or '(empty)'}.\n"
        )
    return (
        "Extract resume-tailoring keywords from this job description.\n"
        f"Job title: {title or '(empty)'}\n"
        f"{role_context}"
        f"Job description excerpt:\n{excerpt or '(empty)'}\n\n"
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
        lane_line += f"Unsupported examples from workflow policy: {join_values(unsupported_examples)}.\n"
    return (
        "Fill missing job metadata from the job description.\n"
        f"Input title: {input_title or '(empty)'}\n"
        f"Missing fields to fill: {join_values(missing_fields) or '(none)'}\n"
        f"Job description excerpt:\n{description_excerpt or '(empty)'}\n"
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
        f"Job title: {job_title or '(empty)'}\n"
        f"Candidate evidence: {(candidate_context or '')[:3000]}\n"
        f"Candidate keywords: {json.dumps(keywords)}\n"
        f"{retry_line}"
        f"Summary keyword policy: {summary_keyword_policy} "
        "Include 0 to 3 exact Candidate keywords. "
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
        f"Job title: {job_title or '(empty)'}\n"
        f"Existing skills: {json.dumps(existing_skills)}\n"
        f"Candidate keywords: {json.dumps(keywords)}\n"
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
        lane_line += f"Unsupported examples from workflow policy: {join_values(unsupported_examples)}.\n"
    policy_line = "Set unsupported_target_role=true only when the posting clearly violates the supplied target-lane policy.\n"

    return (
        "Check whether a queued job is outside the target lane after RAG found very few high-confidence matches between the job description keywords and the stored resume.\n"
        "This check is only for queued jobs already stored in the workflow. Apply supplied workflow policy only; do not decide whether tailoring should continue and do not judge whether every keyword is visibly proven by the resume.\n"
        f"{lane_line}"
        f"{policy_line}"
        f"Job title: {title or '(empty)'}\n"
        f"Job description excerpt: {build_jd_prompt_excerpt(description, 2200) or '(empty)'}\n"
        f"Extracted keywords: {json.dumps(keywords)}\n"
        f"RAG keyword tiers: {json.dumps(compact_scores)}\n"
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
        f"Candidate evidence: {(candidate_context or '')[:3000]}\n"
        f"Requested keywords: {json.dumps(keywords)}\n"
        f"Summary: {summary}\n"
        "Accept only if summary is coherent, polished, and positioned for this candidate. "
        "Reject awkward keyword stuffing, copied bullet phrasing, forced domain/tool claims, obvious exaggeration, or banned filler tone. "
        f"Banned phrases: {join_values(summary_banned_phrases)}. "
        "Do not reject because unused keywords exist. Keep each reason under 100 characters.\n"
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
        f"Optional job description keywords, max 3 if natural:\n{kw_list}\n"
        if kw_list
        else ""
    )
    existing_line = (
        f"Existing resume summary for context:\n{existing_summary.strip()}\n"
        if existing_summary.strip()
        else ""
    )
    feedback_line = (
        f"Retry/length feedback to address:\n{line_feedback.strip()}\n"
        if line_feedback.strip()
        else ""
    )
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
        "Write 2-3 sentence resume summary, 80-100 words, aiming near 4.5 printed lines. "
        "Summary should paraphrase candidate background and add in keywords where we can instead of only copying it"
        "Start with candidate facts and skills, then job fit. "
        f"{role_instruction}"
        f"No fillers and dont use bloat like: {join_values(summary_banned_phrases)}. "
        "Do not use banned phrases or variants. State what the candidate does, not what they want. "
        "Do not imply direct domain experience unless it fits the job, we aim for good flow over truthfulness of the candidate's abilities. "
        "If strong targeted summary does not fit, return empty summary.\n"
        'Only accepted answer format: {"summary": "...", "keywords_used": ["..."], "keyword_use_reason": "...", "retry_reason": "..."}. '
        "keywords_used must list exact optional job description keywords used in summary. "
        "keyword_use_reason must briefly say why those keywords were used, or why none were used. "
        "retry_reason must be empty unless Retry/length feedback exists; if retrying, say what style issue was fixed. "
        "No markdown. No prose. No extra keys."
    )


def build_validate_rewrite_prompt(
    *,
    original: str,
    rewritten: str,
    requested_keywords: list[str],
    rewrite_examples: str = C2_REWRITE_EXAMPLES,
) -> str:
    return (
        "Validate whether a rewritten resume bullet preserves the original meaning while adding resume keywords that still make sense.\n"
        f"Original bullet: {original}\n"
        f"Rewritten bullet: {rewritten}\n"
        f"Requested keywords: {', '.join(requested_keywords)}\n"
        "Judge each requested keyword independently. A rewritten bullet may be partially "
        "supported: put supported keywords in keywords_supported and unsupported keywords "
        "in keywords_rejected.\n"
        "Accept adjacent framing when it stays in the same work context, same outcome, "
        "and coherent technology/workflow family. The keyword does not need to appear "
        "explicitly in the original bullet if it still describes the same kind of work.\n"
        "Reject when the rewrite changes the meaning of the bullet completely, changes the project "
        "or business domain, invents a new responsibility, claims a different outcome, "
        "or creates an incoherent relationship between terms.\n"
        f"Rewrite examples/policy: {rewrite_examples}\n"
        "The rewrite does not need to be stronger than the original. It only needs to "
        "include supported keywords while still reading naturally and making sense in "
        "the original context.\n"
        "Preserve the bullet's original format and order where possible: outcome or "
        "metric first, then action, method, tool, or scope (the google xyz resume method). Reject lazy keyword stuffing "
        "that appends a phrase without fitting the sentence naturally.\n"
        "Do not reject solely because the keyword is not explicit in the original text. "
        'Return only: {"accepted": boolean, "keywords_supported": [...], '
        '"keywords_rejected": [...], "reason": "..."}'
    )


def build_repair_rewrite_prompt(
    *,
    original: str,
    rewritten: str,
    requested_keywords: list[str],
    validation: dict[str, Any],
    rewrite_examples: str = C2_REWRITE_EXAMPLES,
) -> str:
    rejected = validation.get("keywords_rejected") or []
    supported = validation.get("keywords_supported") or []
    return (
        "Repair this resume bullet rewrite after validation feedback.\n"
        f"Original bullet: {original}\n"
        f"Rejected rewrite: {rewritten}\n"
        f"Requested keywords: {', '.join(requested_keywords)}\n"
        f"Supported keywords from validation: {', '.join(supported)}\n"
        f"Rejected keywords from validation: {', '.join(rejected)}\n"
        f"Validation reason: {validation.get('reason') or validation.get('reasons') or ''}\n"
        "Write one coherent bullet in the same Google XYZ-style structure as the original: "
        "preserve outcome/metric, action, method, tools, and scope. Use only keywords "
        "that fit the same work context. Skip keywords that would change the meaning, "
        "invent a different domain, or create incoherent relationships between terms.\n"
        f"Rewrite examples/policy: {rewrite_examples}\n"
        'Return only: {"bullet": "...", "keywords_used": [...], "keywords_skipped": [...]}'
    )


def build_rewrite_bullet_prompt(
    *,
    bullet: str,
    keywords: list[str],
    keywords_to_preserve: list[str] | None = None,
    rewrite_examples: str = C2_REWRITE_EXAMPLES,
) -> str:
    kw_list = ", ".join(keywords)
    preserve_line = ""
    if keywords_to_preserve:
        preserve_line = (
            f"Keywords already in this bullet that must stay: {', '.join(keywords_to_preserve)}.\n"
        )
    return (
        f"Rewrite this resume bullet to naturally weave in these keywords only where they fit cleanly: {kw_list}\n"
        f"{preserve_line}"
        "Fit and readability matter more than keyword coverage. If there is more than one keyword, you do not need to fit all of them. Skip any keyword that would make the bullet awkward, vague, or less believable.\n"
        "Try these strategies in order. Stop after the first strategy that produces a coherent, natural rewrite:\n"
        "1. REPLACE: If a keyword names the same type of technology, method, or concept as something already in the bullet, replace or substitute naturally.\n"
        "2. REWORD: If replacement does not work, reword or restructure the bullet so the original work and the keyword appear together naturally. The keyword must fit the actual work described by the original bullet.\n"
        "3. ADD SENTENCE: If one or more keywords still fit but cannot be included by replacement or rewording, add at most one new sentence anywhere in the bullet. The new sentence must be directly about the original work. Pack multiple remaining keywords into that one sentence only if they fit naturally.\n"
        "4. STOP: Any remaining keywords that do not fit cleanly go in keywords_skipped. Do not force them.\n"
        "Rules:\n"
        "- Preserve all original facts, metrics, numbers, scope, and outcomes.\n"
        "- Preserve the original bullet's order and Google XYZ-style structure when possible: outcome or metric first, then action, method, tool, or scope.\n"
        "- Do not invent a new outcome, tool usage, product domain, customer domain, or responsibility.\n"
        "- It is OK to use adjacent wording that is not explicit in the original if it stays in the same work context, same outcome, and coherent technology/workflow family.\n"
        "- Do not combine technologies, vendors, resources, or workflows in a way that would sound incoherent or imply a different project.\n"
        "- Do not explain what a technology does. Use technology and domain phrases as names.\n"
        "- Do not claim a technology was used for an unrelated purpose or a different workflow than the original bullet.\n"
        "- Reject your own rewrite by skipping the keyword if the final bullet would sound like keyword stuffing.\n"
        "- If a keyword is an action phrase, keep the action and object visibly together. For any keyword beginning with Monitor, write monitoring plus the rest of the keyword if it fits the bullet. For any keyword beginning with Automate, write automating plus the rest of the keyword if it fits the bullet. Otherwise put that keyword in keywords_skipped.\n"
        "- Do not count scattered words as using an action keyword. Example: monitors in one clause plus data pipelines somewhere else does not count as Monitor data pipelines.\n"
        f"- Rewrite examples/policy: {rewrite_examples}\n"
        "- Avoid lazy append phrases such as utilizing X or leveraging X unless X naturally explains the method or context of the original work.\n"
        "- At most one new sentence total.\n"
        "- Keep the rewritten bullet concise. It should usually be close to the original length and never more than 20 percent longer unless needed to preserve grammar.\n"
        f"Bullet: {bullet.strip()}\n"
        'Return only: {"bullet": "...", "keywords_used": [...], "keywords_skipped": [...]}'
    )
