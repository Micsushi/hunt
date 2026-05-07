from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import TYPE_CHECKING, Any

from .. import config
from ..job_metadata_settings import load_c2_prompt_settings, load_job_metadata_settings
from ..jobs.keyword_policy import KeywordKind, classify_keyword_policy
from . import prompt_templates as prompts

if TYPE_CHECKING:
    from ..pipeline_logger import PipelineLogger

_LOG_LLM = False  # per-call LLM noise suppressed; full trace printed by pipeline._print_trace


def _llm_log(call_name: str, prompt: str, response: str, duration_ms: int | None) -> None:
    if not _LOG_LLM:
        return
    sep = "-" * 60
    prompt_preview = prompt.replace("\n", " ").strip()[:300]
    response_preview = response.replace("\n", " ").strip()[:300]
    ms = f"{duration_ms}ms" if duration_ms is not None else "?"
    print(f"\n[LLM] {call_name} | {ms}")
    print(f"  prompt  : {prompt_preview}")
    print(f"  response: {response_preview}")
    print(sep)


def _extract_json_object(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    if raw.startswith("```"):
        lines = raw.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        raw = "\n".join(lines).strip()
    match = re.search(r"\{[\s\S]*\}\s*$", raw)
    if match:
        raw = match.group(0)
    return json.loads(raw)


def _dedupe_case(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        item = str(value).strip()
        key = item.lower()
        if item and key not in seen:
            seen.add(key)
            out.append(item)
    return out


def capitalize_skill_phrase(value: str) -> str:
    """Uppercase the first alphabetic character in a skill phrase."""
    item = str(value or "").strip()
    for idx, char in enumerate(item):
        if char.isalpha():
            return f"{item[:idx]}{char.upper()}{item[idx + 1 :]}"
    return item


def build_jd_prompt_excerpt(description: str, max_chars: int) -> str:
    return prompts.build_jd_prompt_excerpt(description, max_chars)


def categorize_keyword(keyword: str) -> str:
    if classify_keyword_policy(keyword).kind == KeywordKind.DOMAIN:
        return "domain"
    return "tech"


def keyword_requires_direct_support(keyword: str) -> bool:
    return False


def _derive_keyword_outcome(
    requested_keywords: list[str],
    supported_keywords: list[str],
    rejected_keywords: list[str],
) -> tuple[list[str], list[str]]:
    rejected_l = {kw.lower() for kw in _dedupe_case(rejected_keywords)}
    used = [kw for kw in _dedupe_case(supported_keywords) if kw.lower() not in rejected_l]
    used_l = {kw.lower() for kw in used}
    skipped = [
        kw for kw in requested_keywords if kw.lower() not in used_l or kw.lower() in rejected_l
    ]
    return used, _dedupe_case(skipped)


def _clean_keyword_outcome(
    requested_keywords: list[str],
    used_keywords: list[str],
    skipped_keywords: list[str],
) -> tuple[list[str], list[str]]:
    requested_by_lower = {kw.lower(): kw for kw in requested_keywords}
    used = _filter_requested_keywords(_dedupe_case(used_keywords), requested_keywords)
    used_l = {kw.lower() for kw in used}
    skipped = [
        requested_by_lower.get(kw.lower(), kw)
        for kw in _dedupe_case(skipped_keywords)
        if kw.lower() in requested_by_lower and kw.lower() not in used_l
    ]
    return used, _dedupe_case(skipped)


def _filter_requested_keywords(values: list[str], requested_keywords: list[str]) -> list[str]:
    requested_by_lower = {kw.lower(): kw for kw in requested_keywords}
    filtered: list[str] = []
    for value in values:
        key = (value or "").strip().lower()
        if key in requested_by_lower:
            filtered.append(requested_by_lower[key])
    return _dedupe_case(filtered)


def _normalize_visible_text(text: str) -> str:
    value = re.sub(r"[^a-z0-9+#.]+", " ", (text or "").lower())
    return re.sub(r"\s+", " ", value).strip()


def _is_blocked_ide_keyword(keyword: str) -> bool:
    settings = load_c2_prompt_settings()
    blocked = {
        _normalize_visible_text(str(value))
        for value in settings.get("blocked_keywords", [])
        if str(value).strip()
    }
    return _normalize_visible_text(keyword) in blocked


def _clean_extracted_keywords(
    values: list[str],
    *,
    limit: int | None = None,
) -> list[str]:
    if limit is None:
        limit = int(load_c2_prompt_settings().get("keyword_selection_max_keywords") or 0)
    if limit <= 0:
        return []
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = str(value or "").strip()
        key = item.lower()
        if not item or key in seen or _is_blocked_ide_keyword(item):
            continue
        seen.add(key)
        cleaned.append(item)
        if len(cleaned) >= limit:
            break
    return cleaned


def _object_variants(object_text: str) -> list[str]:
    normalized = _normalize_visible_text(object_text)
    variants = [normalized]
    if normalized.endswith("ies"):
        variants.append(f"{normalized[:-3]}y")
    elif normalized.endswith("s"):
        variants.append(normalized[:-1])
    return _dedupe_case([v for v in variants if v])


def _visible_action_phrases(keyword: str) -> tuple[str, ...]:
    key = _normalize_visible_text(keyword)
    action_variants: dict[str, tuple[str, ...]] = {
        "automate": ("automate", "automated", "automating", "automation of"),
        "monitor": ("monitor", "monitored", "monitoring"),
        "operationalize": ("operationalize", "operationalized", "operationalizing"),
        "productionalize": ("productionalize", "productionalized", "productionalizing"),
    }
    for action, variants in action_variants.items():
        prefix = f"{action} "
        if not key.startswith(prefix):
            continue
        obj = key.removeprefix(prefix).strip()
        phrases: list[str] = []
        for object_variant in _object_variants(obj):
            phrases.extend(f"{variant} {object_variant}" for variant in variants)
            if action == "automate":
                phrases.append(f"{object_variant} automation")
            elif action == "monitor":
                phrases.append(f"{object_variant} monitoring")
        return tuple(_dedupe_case(phrases))
    return ()


def _find_matching_brace(text: str, open_idx: int) -> int:
    depth = 0
    for idx in range(open_idx, len(text)):
        char = text[idx]
        escaped = idx > 0 and text[idx - 1] == "\\"
        if char == "{" and not escaped:
            depth += 1
        elif char == "}" and not escaped:
            depth -= 1
            if depth == 0:
                return idx
    return -1


def _read_braced(text: str, open_idx: int) -> tuple[str, int] | None:
    if open_idx >= len(text) or text[open_idx] != "{":
        return None
    close_idx = _find_matching_brace(text, open_idx)
    if close_idx < 0:
        return None
    return text[open_idx + 1 : close_idx], close_idx + 1


def _clean_latex_visible_text(text: str) -> str:
    cleaned = re.sub(r"\\href\{[^{}]*\}\{([^{}]*)\}", r"\1", text or "")
    cleaned = re.sub(r"\\textbf\{([^{}]*)\}", r"\1", cleaned)
    cleaned = re.sub(r"\\([#$%&_{}])", r"\1", cleaned)
    cleaned = re.sub(r"\\[a-zA-Z]+\*?(?:\[[^\]]*\])?", "", cleaned)
    return re.sub(r"\s+", " ", cleaned.replace("{", "").replace("}", "")).strip()


def _extract_textbf_phrases(text: str) -> list[str]:
    phrases: list[str] = []
    cursor = 0
    while True:
        start = text.find(r"\textbf", cursor)
        if start < 0:
            break
        content = _read_braced(text, start + len(r"\textbf"))
        if not content:
            cursor = start + len(r"\textbf")
            continue
        visible = _clean_latex_visible_text(content[0])
        if visible:
            phrases.append(visible)
        cursor = content[1]
    return _dedupe_case(phrases)


def _textbf_spans(text: str) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    cursor = 0
    while True:
        start = text.find(r"\textbf", cursor)
        if start < 0:
            break
        content = _read_braced(text, start + len(r"\textbf"))
        if not content:
            cursor = start + len(r"\textbf")
            continue
        spans.append((start, content[1]))
        cursor = content[1]
    return spans


def _inside_spans(start: int, end: int, spans: list[tuple[int, int]]) -> bool:
    return any(span_start <= start and end <= span_end for span_start, span_end in spans)


def _phrase_pattern(phrase: str) -> re.Pattern[str]:
    escaped = re.escape(phrase)
    prefix = r"(?<![A-Za-z0-9])" if phrase[:1].isalnum() else ""
    suffix = r"(?![A-Za-z0-9])" if phrase[-1:].isalnum() else ""
    return re.compile(f"{prefix}{escaped}{suffix}", re.IGNORECASE)


def _escape_latex_inline(text: str) -> str:
    result = text
    for char in ("$", "%", "&", "#"):
        result = re.sub(r"(?<!\\)" + re.escape(char), "\\" + char, result)
    return result


def restore_textbf_from_original(original: str, rewritten: str) -> str:
    """Restore first-occurrence bold spans from the original bullet after model rewrite."""
    output = rewritten or ""
    for phrase in _extract_textbf_phrases(original or ""):
        spans = _textbf_spans(output)
        pattern = _phrase_pattern(phrase)
        for match in pattern.finditer(output):
            if _inside_spans(match.start(), match.end(), spans):
                continue
            bold_text = _escape_latex_inline(match.group(0))
            output = f"{output[: match.start()]}\\textbf{{{bold_text}}}{output[match.end() :]}"
            break
    return output


def keyword_visible_in_text(keyword: str, text: str) -> bool:
    """Return true when a requested keyword is visibly represented in text."""
    key = _normalize_visible_text(keyword)
    visible = _normalize_visible_text(text)
    if not key or not visible:
        return False
    allowed = [key]
    allowed.extend(_visible_action_phrases(key))
    return any(_normalize_visible_text(phrase) in visible for phrase in allowed)


def _rewrite_prompt_policy_kwargs(
    prompt_settings: dict[str, object],
    *,
    include_strategy: bool = False,
) -> dict[str, str]:
    kwargs = {
        "rewrite_keyword_fit_policy": str(prompt_settings.get("rewrite_keyword_fit_policy") or ""),
        "rewrite_bullet_policy": str(prompt_settings.get("rewrite_bullet_policy") or ""),
        "rewrite_length_policy": str(prompt_settings.get("rewrite_length_policy") or ""),
        "rewrite_action_keyword_policy": str(
            prompt_settings.get("rewrite_action_keyword_policy") or ""
        ),
    }
    if include_strategy:
        kwargs["rewrite_strategy"] = str(prompt_settings.get("rewrite_strategy") or "")
    return kwargs


def validate_rewrite_with_ollama(
    *,
    original: str,
    rewritten: str,
    requested_keywords: list[str],
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    if config.resume_llm_provider() != "ollama":
        return {
            "accepted": True,
            "keywords_supported": list(requested_keywords),
            "keywords_rejected": [],
            "reason": "validator_disabled",
        }

    prompt_settings = load_c2_prompt_settings()
    prompt = prompts.build_validate_rewrite_prompt(
        original=original,
        rewritten=rewritten,
        requested_keywords=requested_keywords,
        **_rewrite_prompt_policy_kwargs(prompt_settings),
    )
    start = time.perf_counter()
    raw = _ollama_chat(prompt)
    duration_ms = int((time.perf_counter() - start) * 1000)
    if logger:
        logger.llm_call("validate_rewrite", prompt, raw, duration_ms, success=True)
    parsed = _extract_json_object(raw)
    supported = parsed.get("keywords_supported")
    rejected = parsed.get("keywords_rejected")
    supported_list = _filter_requested_keywords(
        _dedupe_case(supported if isinstance(supported, list) else []),
        requested_keywords,
    )
    rejected_list = _filter_requested_keywords(
        _dedupe_case(rejected if isinstance(rejected, list) else []),
        requested_keywords,
    )
    if not bool(parsed.get("accepted")) and not rejected_list:
        supported_l = {kw.lower() for kw in supported_list}
        rejected_list = [kw for kw in requested_keywords if kw.lower() not in supported_l]
        if not rejected_list:
            rejected_list = list(requested_keywords)
    return {
        "accepted": bool(parsed.get("accepted")),
        "keywords_supported": supported_list,
        "keywords_rejected": rejected_list,
        "reason": str(parsed.get("reason") or ""),
    }


def validate_summary_grounding(
    summary: str,
    candidate_context: str,
    keywords: list[str],
) -> dict[str, Any]:
    """Compatibility wrapper: summary quality belongs to the LLM validation prompt."""
    return {"accepted": True, "reasons": []}


def _ollama_chat(user_prompt: str, *, temperature: float = 0.1) -> str:
    host = config.ollama_host()
    model = config.ollama_model_name()
    timeout = config.ollama_timeout_sec()
    payload = {
        "model": model,
        "format": "json",
        "stream": False,
        "keep_alive": config.ollama_keep_alive_payload(),
        "options": {"temperature": temperature},
        "messages": [
            {
                "role": "system",
                "content": prompts.OLLAMA_SYSTEM_PROMPT,
            },
            {"role": "user", "content": user_prompt},
        ],
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{host}/api/chat",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.load(resp)
    message = body.get("message") or {}
    return (message.get("content") or "").strip()


def _keyword_selection_prompt() -> str:
    prompt_settings = load_c2_prompt_settings()
    return prompts.keyword_selection_prompt(
        max_keywords=int(prompt_settings.get("keyword_selection_max_keywords") or 0),
        min_words=int(prompt_settings.get("keyword_selection_min_words") or 0),
        max_words=int(prompt_settings.get("keyword_selection_max_words") or 0),
        min_confidence=float(prompt_settings.get("job_metadata_min_confidence") or 0.0),
        keep_policy=str(prompt_settings.get("keyword_keep_policy") or ""),
        ignore_policy=str(prompt_settings.get("keyword_ignore_policy") or ""),
    )


def _build_user_prompt(
    title: str,
    description: str,
    *,
    role_family: str = "",
    job_level: str = "",
) -> str:
    prompt_settings = load_c2_prompt_settings()
    return prompts.build_keyword_extract_prompt(
        title,
        description,
        role_family=role_family,
        job_level=job_level,
        max_keywords=int(prompt_settings.get("keyword_selection_max_keywords") or 0),
        min_words=int(prompt_settings.get("keyword_selection_min_words") or 0),
        max_words=int(prompt_settings.get("keyword_selection_max_words") or 0),
        min_confidence=float(prompt_settings.get("job_metadata_min_confidence") or 0.0),
        keep_policy=str(prompt_settings.get("keyword_keep_policy") or ""),
        ignore_policy=str(prompt_settings.get("keyword_ignore_policy") or ""),
    )


def _apply_jd_keywords(
    parsed: dict[str, Any],
    *,
    classification: dict,
    keywords: dict,
) -> tuple[dict, dict]:
    """Merge Ollama jd_usable + keywords into classification and keywords dicts."""
    jd_usable_raw = parsed.get("jd_usable")
    jd_usable = jd_usable_raw if isinstance(jd_usable_raw, bool) else True

    reason = parsed.get("jd_usable_reason")
    reason_str = reason.strip() if isinstance(reason, str) else ""
    unsupported_target_role = bool(parsed.get("unsupported_target_role"))
    unsupported_reason = parsed.get("unsupported_target_reason")
    unsupported_reason_str = (
        unsupported_reason.strip() if isinstance(unsupported_reason, str) else ""
    )

    raw_list = parsed.get("keywords")
    if not isinstance(raw_list, list):
        raise ValueError("keywords must be an array")
    terms = _clean_extracted_keywords(
        [item for item in raw_list if isinstance(item, str)],
        limit=30,
    )

    if not jd_usable:
        terms = []

    new_c = dict(classification)
    new_c["weak_description"] = not jd_usable
    flags = list(new_c.get("concern_flags") or [])
    if not jd_usable:
        if "weak_description" not in flags:
            flags.append("weak_description")
    else:
        flags = [f for f in flags if f != "weak_description"]
    new_c["concern_flags"] = flags
    if reason_str:
        reasons = list(new_c.get("reasons") or [])
        reasons.append(f"jd_usable_model: {reason_str[:200]}")
        new_c["reasons"] = reasons[:24]
    if unsupported_target_role:
        flags = list(new_c.get("concern_flags") or [])
        if "unsupported_target_role" not in flags:
            flags.append("unsupported_target_role")
        new_c["concern_flags"] = flags
        reasons = list(new_c.get("reasons") or [])
        if unsupported_reason_str:
            reasons.append(f"unsupported_target_role_model: {unsupported_reason_str[:200]}")
        new_c["reasons"] = reasons[:24]

    new_k = dict(keywords)
    new_k["must_have_terms"] = terms
    new_k["nice_to_have_terms"] = []
    new_k["tools_and_technologies"] = list(terms)
    new_k["domain_terms"] = []
    return new_c, new_k


def analyze_job_fit_with_ollama(
    *,
    input_title: str,
    deterministic_title: str,
    description: str,
    missing_fields: list[str] | None = None,
    target_lane_policy: str = "",
    unsupported_examples: list[str] | None = None,
    role_family_values: list[str] | None = None,
    job_level_values: list[str] | None = None,
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Fill missing job metadata in one model judgment."""
    result: dict[str, Any] = {
        "success": False,
        "title": deterministic_title or "",
        "role_family": "",
        "job_level": "",
        "mismatch": False,
        "mismatch_reason": "",
        "unsupported_target_role": False,
        "unsupported_target_reason": "",
        "jd_usable": None,
        "jd_usable_reason": "",
        "error": None,
        "duration_ms": None,
    }
    if config.resume_llm_provider() != "ollama":
        return result
    target_lane_policy = (target_lane_policy or "").strip()
    missing_fields = missing_fields or ["title", "role_family", "job_level"]
    metadata_settings = load_job_metadata_settings()
    prompt_settings = load_c2_prompt_settings()
    allowed_role_families = role_family_values or metadata_settings["role_families"]
    allowed_job_levels = job_level_values or metadata_settings["job_levels"]
    prompt = prompts.build_job_metadata_prompt(
        input_title=input_title or deterministic_title,
        description=description,
        missing_fields=missing_fields,
        role_family_values=allowed_role_families,
        job_level_values=allowed_job_levels,
        max_chars=int(prompt_settings.get("job_metadata_prompt_max_chars") or 0),
        min_confidence=float(prompt_settings.get("job_metadata_min_confidence") or 0.0),
        target_lane_policy=target_lane_policy,
        unsupported_examples=unsupported_examples,
    )
    start = time.perf_counter()
    try:
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        if logger:
            logger.llm_call("analyze_job_fit", prompt, raw, result["duration_ms"], success=True)
        parsed = _extract_json_object(raw)
        jd_usable = parsed.get("jd_usable")
        if not isinstance(jd_usable, bool):
            jd_usable = bool((description or "").strip()) and not bool(parsed.get("mismatch"))
        unsupported_target_role = bool(parsed.get("unsupported_target_role"))
        unsupported_target_reason = str(parsed.get("unsupported_target_reason") or "").strip()[:240]
        if not target_lane_policy:
            unsupported_target_role = False
            unsupported_target_reason = ""
        confidence = float(parsed.get("confidence") or 0.0)
        title_value = str(parsed.get("title") or deterministic_title or "").strip()[:120]
        family_value = str(parsed.get("role_family") or "").strip().lower()
        level_value = str(parsed.get("job_level") or "").strip().lower()
        if family_value and family_value not in {value.lower() for value in allowed_role_families}:
            family_value = ""
        if level_value and level_value not in {value.lower() for value in allowed_job_levels}:
            level_value = ""
        if confidence < float(prompt_settings.get("job_metadata_min_confidence") or 0.0):
            title_value = deterministic_title or ""
            family_value = ""
            level_value = ""
        result.update(
            {
                "success": True,
                "title": title_value,
                "role_family": family_value,
                "job_level": level_value,
                "mismatch": bool(parsed.get("mismatch")),
                "mismatch_reason": str(parsed.get("mismatch_reason") or "").strip()[:240],
                "unsupported_target_role": unsupported_target_role,
                "unsupported_target_reason": unsupported_target_reason,
                "confidence": confidence,
                "jd_usable": jd_usable,
                "jd_usable_reason": str(parsed.get("jd_usable_reason") or "").strip()[:500],
            }
        )
    except Exception as exc:
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        result["error"] = str(exc) or exc.__class__.__name__
        if logger:
            logger.llm_call(
                "analyze_job_fit",
                prompt,
                str(exc),
                result["duration_ms"],
                success=False,
                error=result["error"],
            )
    return result


def extract_keywords_with_ollama(
    *,
    title: str,
    description: str,
    role_family: str = "",
    job_level: str = "",
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Extract clean JD keywords in a dedicated model call."""
    result: dict[str, Any] = {
        "success": False,
        "keywords": [],
        "error": None,
        "duration_ms": None,
        "prompt_excerpt_len": 0,
    }
    if config.resume_llm_provider() != "ollama":
        return result
    prompt = _build_user_prompt(
        title,
        description,
        role_family=role_family,
        job_level=job_level,
    )
    result["prompt_excerpt_len"] = len(build_jd_prompt_excerpt(description, 4500))
    start = time.perf_counter()
    try:
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        if logger:
            logger.llm_call("keyword_extract", prompt, raw, result["duration_ms"], success=True)
        parsed = _extract_json_object(raw)
        raw_keywords = parsed.get("keywords")
        if not isinstance(raw_keywords, list):
            raise ValueError("keywords must be an array")
        result.update(
            {
                "success": True,
                "keywords": _clean_extracted_keywords(
                    [keyword for keyword in raw_keywords if isinstance(keyword, str)],
                    limit=int(load_c2_prompt_settings().get("keyword_selection_max_keywords") or 0),
                ),
            }
        )
    except Exception as exc:
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        result["error"] = str(exc) or exc.__class__.__name__
        if logger:
            logger.llm_call(
                "keyword_extract",
                prompt,
                str(exc),
                result["duration_ms"],
                success=False,
                error=result["error"],
            )
    return result


def filter_summary_keywords_with_ollama(
    *,
    keywords: list[str],
    candidate_context: str,
    job_title: str,
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Choose summary keywords with model judgment instead of rigid string rules."""
    result = {
        "included": list(keywords),
        "excluded": [],
        "success": False,
        "error": None,
        "duration_ms": None,
    }
    if config.resume_llm_provider() != "ollama" or not keywords:
        return result
    requested_l = {keyword.lower() for keyword in _dedupe_case(keywords)}
    prompt_settings = load_c2_prompt_settings()

    def build_prompt(*, retry: bool = False) -> str:
        return prompts.build_summary_keyword_filter_prompt(
            keywords=keywords,
            candidate_context=candidate_context,
            job_title=job_title,
            summary_keyword_policy=str(prompt_settings.get("summary_keyword_policy") or ""),
            retry=retry,
        )

    for attempt in range(2):
        prompt = build_prompt(retry=attempt > 0)
        start = time.perf_counter()
        try:
            raw = _ollama_chat(prompt)
            result["duration_ms"] = int((time.perf_counter() - start) * 1000)
            parsed = _extract_json_object(raw)
            raw_values = []
            for key in ("included", "excluded"):
                if isinstance(parsed.get(key), list):
                    raw_values.extend(str(value).strip() for value in parsed[key])
            invalid = [
                value
                for value in _dedupe_case(raw_values)
                if value and value.lower() not in requested_l
            ]
            if logger:
                logger.llm_call(
                    "summary_keyword_filter",
                    prompt,
                    raw,
                    result["duration_ms"],
                    success=True,
                )
            if invalid:
                if logger:
                    logger.step(
                        "summary_keyword_filter_invalid_output",
                        invalid_terms=invalid,
                        retry=attempt == 0,
                    )
                if attempt == 0:
                    continue
            included = _filter_requested_keywords(
                _dedupe_case(
                    parsed.get("included") if isinstance(parsed.get("included"), list) else []
                ),
                keywords,
            )
            excluded = _filter_requested_keywords(
                _dedupe_case(
                    parsed.get("excluded") if isinstance(parsed.get("excluded"), list) else []
                ),
                keywords,
            )
            if included or excluded:
                included = included[:3]
                included_l = {kw.lower() for kw in included}
                excluded = [
                    kw for kw in _dedupe_case(excluded + keywords) if kw.lower() not in included_l
                ]
                result.update({"included": included, "excluded": excluded, "success": True})
                return result
        except Exception as exc:
            result["duration_ms"] = int((time.perf_counter() - start) * 1000)
            result["error"] = str(exc) or exc.__class__.__name__
            if logger:
                logger.llm_call(
                    "summary_keyword_filter",
                    prompt,
                    str(exc),
                    result["duration_ms"],
                    success=False,
                    error=result["error"],
                )
            if attempt == 0:
                continue
    return result


def bucket_skill_keywords_with_ollama(
    *,
    keywords: list[str],
    existing_skills: dict[str, list[str]],
    job_title: str = "",
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Ask the model which unused keywords belong in resume skill buckets."""
    result = {
        "success": False,
        "languages": [],
        "frameworks": [],
        "developer_tools": [],
        "ignored": list(keywords),
        "error": None,
        "duration_ms": None,
    }
    if config.resume_llm_provider() != "ollama" or not keywords:
        return result
    required_categories = ("languages", "frameworks", "developer_tools")
    allowed_categories = (
        tuple(
            category
            for category in existing_skills
            if isinstance(category, str) and category.strip()
        )
        or required_categories
    )
    requested_l = {keyword.lower() for keyword in _dedupe_case(keywords)}
    prompt_settings = load_c2_prompt_settings()
    skill_addition_limit = int(prompt_settings.get("skill_addition_limit") or 0)
    if skill_addition_limit <= 0:
        result["success"] = True
        return result

    def build_prompt(*, retry: bool = False) -> str:
        return prompts.build_skill_bucket_prompt(
            keywords=keywords,
            existing_skills=existing_skills,
            skill_addition_limit=skill_addition_limit,
            job_title=job_title,
            min_confidence=float(prompt_settings.get("job_metadata_min_confidence") or 0.0),
            skill_addition_policy=str(prompt_settings.get("skill_addition_policy") or ""),
            retry=retry,
        )

    for attempt in range(2):
        prompt = build_prompt(retry=attempt > 0)
        start = time.perf_counter()
        try:
            raw = _ollama_chat(prompt)
            result["duration_ms"] = int((time.perf_counter() - start) * 1000)
            parsed = _extract_json_object(raw)
            additions_raw = parsed.get("additions")
            ignored_raw = parsed.get("ignored")
            missing_keys = []
            if not isinstance(additions_raw, (dict, list)):
                missing_keys.append("additions")
            if not isinstance(ignored_raw, list):
                missing_keys.append("ignored")
            raw_values = []
            if isinstance(additions_raw, dict):
                raw_values.extend(str(keyword).strip() for keyword in additions_raw)
            elif isinstance(additions_raw, list):
                for item in additions_raw:
                    if isinstance(item, dict):
                        raw_values.append(str(item.get("keyword") or "").strip())
                    else:
                        raw_values.append(str(item).strip())
            if isinstance(ignored_raw, list):
                raw_values.extend(str(value).strip() for value in ignored_raw)
            invalid = [
                value
                for value in _dedupe_case(raw_values)
                if value and value.lower() not in requested_l
            ]
            if logger:
                logger.llm_call(
                    "bucket_skill_keywords",
                    prompt,
                    raw,
                    result["duration_ms"],
                    success=True,
                )
            if missing_keys:
                if logger:
                    logger.step(
                        "skill_bucket_invalid_output",
                        missing_keys=missing_keys,
                        invalid_terms=invalid,
                        retry=attempt == 0,
                    )
                if attempt == 0:
                    continue
            elif invalid and logger:
                logger.step(
                    "skill_bucket_invalid_output",
                    missing_keys=[],
                    invalid_terms=invalid,
                    retry=False,
                )
            additions: list[tuple[str, str]] = []
            if isinstance(additions_raw, dict):
                for raw_keyword, raw_category in additions_raw.items():
                    keyword = str(raw_keyword or "").strip()
                    category = str(raw_category or "").strip()
                    if category not in allowed_categories:
                        continue
                    filtered = _filter_requested_keywords([keyword], keywords)
                    if filtered:
                        additions.append((filtered[0], category))
            elif isinstance(additions_raw, list):
                for item in additions_raw:
                    if not isinstance(item, dict):
                        continue
                    keyword = str(item.get("keyword") or "").strip()
                    category = str(item.get("category") or "").strip()
                    if category not in allowed_categories:
                        continue
                    filtered = _filter_requested_keywords([keyword], keywords)
                    if filtered:
                        additions.append((filtered[0], category))
            seen_additions: set[str] = set()
            for keyword, category in additions:
                display_keyword = capitalize_skill_phrase(keyword)
                key = display_keyword.lower()
                if key in seen_additions:
                    continue
                seen_additions.add(key)
                if (
                    sum(len(result.get(bucket, [])) for bucket in allowed_categories)
                    >= skill_addition_limit
                ):
                    break
                if category not in result:
                    result[category] = []
                result[category].append(display_keyword)
            added_l = {
                keyword.lower()
                for bucket in allowed_categories
                for keyword in result.get(bucket, [])
            }
            ignored = _filter_requested_keywords(
                _dedupe_case(ignored_raw if isinstance(ignored_raw, list) else []),
                keywords,
            )
            result["ignored"] = _dedupe_case(
                ignored + [keyword for keyword in keywords if keyword.lower() not in added_l]
            )
            result["success"] = True
            return result
        except Exception as exc:
            result["duration_ms"] = int((time.perf_counter() - start) * 1000)
            result["error"] = str(exc) or exc.__class__.__name__
            if logger:
                logger.llm_call(
                    "bucket_skill_keywords",
                    prompt,
                    str(exc),
                    result["duration_ms"],
                    success=False,
                    error=result["error"],
                )
            if attempt == 0:
                continue
    return result


def check_low_rag_unsupported_target_with_ollama(
    *,
    title: str,
    description: str,
    keywords: list[str],
    rag_scores: list[dict[str, Any]],
    target_lane_policy: str = "",
    unsupported_examples: list[str] | None = None,
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """For queued jobs, check whether weak RAG indicates an outside-lane role."""
    result: dict[str, Any] = {
        "unsupported_target_role": False,
        "reason": "",
        "success": False,
        "error": None,
        "duration_ms": None,
    }
    target_lane_policy = (target_lane_policy or "").strip()
    if not target_lane_policy:
        result.update({"success": True, "duration_ms": 0})
        return result
    if config.resume_llm_provider() != "ollama":
        return result
    unsupported_examples = unsupported_examples or []

    compact_scores = [
        {
            "keyword": str(score.get("keyword") or "")[:80],
            "tier": str(score.get("tier") or ""),
            "score": score.get("score"),
        }
        for score in rag_scores[:40]
        if isinstance(score, dict)
    ]
    prompt = prompts.build_low_rag_unsupported_target_prompt(
        title=title,
        description=description,
        keywords=_dedupe_case(keywords),
        compact_scores=compact_scores,
        target_lane_policy=target_lane_policy,
        unsupported_examples=unsupported_examples,
    )
    start = time.perf_counter()
    try:
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        parsed = _extract_json_object(raw)
        unsupported = parsed.get("unsupported_target_role")
        if not isinstance(unsupported, bool):
            raise ValueError("unsupported_target_role must be boolean")
        reason = str(parsed.get("reason") or "").strip()[:500]
        result.update(
            {
                "unsupported_target_role": unsupported,
                "reason": reason,
                "success": True,
            }
        )
        if logger:
            logger.llm_call(
                "low_rag_unsupported_target_check",
                prompt,
                raw,
                result["duration_ms"],
                success=True,
            )
    except Exception as exc:
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        result["error"] = str(exc) or exc.__class__.__name__
        if logger:
            logger.llm_call(
                "low_rag_unsupported_target_check",
                prompt,
                str(exc),
                result["duration_ms"],
                success=False,
                error=result["error"],
            )
    return result


def validate_summary_with_ollama(
    *,
    summary: str,
    candidate_context: str,
    keywords: list[str],
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Validate summary positioning and coherence with the model."""
    result = {
        "accepted": True,
        "reasons": [],
        "success": False,
        "duration_ms": None,
        "error": None,
    }
    if config.resume_llm_provider() != "ollama" or not summary:
        return result
    prompt = prompts.build_summary_validation_prompt(
        summary=summary,
        candidate_context=candidate_context,
        keywords=keywords,
        summary_banned_phrases=[
            str(value) for value in load_c2_prompt_settings().get("summary_banned_phrases", [])
        ],
    )
    start = time.perf_counter()
    try:
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        if logger:
            logger.llm_call("validate_summary", prompt, raw, result["duration_ms"], success=True)
        parsed = _extract_json_object(raw)
        reasons = parsed.get("reasons")
        result.update(
            {
                "accepted": bool(parsed.get("accepted")),
                "reasons": reasons if isinstance(reasons, list) else [],
                "success": True,
            }
        )
    except Exception as exc:
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        result["error"] = str(exc) or exc.__class__.__name__
        if logger:
            logger.llm_call(
                "validate_summary",
                prompt,
                str(exc),
                result["duration_ms"],
                success=False,
                error=result["error"],
            )
    return result


def generate_summary(
    candidate_context: str,
    job_title: str,
    keywords: list[str],
    *,
    existing_summary: str = "",
    line_feedback: str = "",
    role_family: str = "",
    job_level: str = "",
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Ask Ollama to generate a professional summary paragraph for this candidate + job.

    candidate_context: brief string built from experience titles/companies + top skills.
    existing_summary: text of any existing resume summary, used as context only.
    line_feedback: optional length-adjustment note for retry calls.
    Returns dict with keys:
      - "summary": generated summary string
      - "success": bool
      - "error": str or None
      - "duration_ms": int or None
    """
    result: dict[str, Any] = {
        "summary": "",
        "success": False,
        "error": None,
        "duration_ms": None,
        "keywords_used": [],
        "keyword_use_reason": "",
        "retry_reason": "",
    }
    if config.resume_llm_provider() != "ollama":
        return result
    if not candidate_context or not job_title:
        return result

    summary_keywords = _dedupe_case(keywords)
    prompt_settings = load_c2_prompt_settings()
    prompt = prompts.build_summary_generation_prompt(
        candidate_context=candidate_context,
        job_title=job_title,
        keywords=summary_keywords,
        existing_summary=existing_summary,
        line_feedback=line_feedback,
        role_family=role_family,
        job_level=job_level,
        summary_good_example=str(prompt_settings.get("summary_good_example") or ""),
        summary_banned_phrases=[
            str(value) for value in prompt_settings.get("summary_banned_phrases", [])
        ],
    )
    start = time.perf_counter()
    try:
        _llm_log("call 2/3: summary [sending]", prompt, "", None)
        raw = _ollama_chat(prompt, temperature=0.0)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        _llm_log("call 2/3: summary [done]", prompt, raw, result["duration_ms"])
        if logger:
            logger.llm_call("generate_summary", prompt, raw, result["duration_ms"], success=True)
        parsed = _extract_json_object(raw)
        text = (parsed.get("summary") or "").strip()
        if text:
            keywords_used = _filter_requested_keywords(
                _dedupe_case(
                    parsed.get("keywords_used")
                    if isinstance(parsed.get("keywords_used"), list)
                    else []
                ),
                summary_keywords,
            )
            result["summary"] = text
            result["keywords_used"] = keywords_used
            result["keyword_use_reason"] = str(parsed.get("keyword_use_reason") or "").strip()[:300]
            result["retry_reason"] = str(parsed.get("retry_reason") or "").strip()[:300]
            result["success"] = True
    except Exception as exc:
        result["error"] = str(exc) or exc.__class__.__name__
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        _llm_log("call 2/3: summary [ERROR]", prompt, str(exc), result["duration_ms"])
        if logger:
            logger.llm_call(
                "generate_summary",
                prompt,
                str(exc),
                result["duration_ms"],
                success=False,
                error=result["error"],
            )
    return result


def rewrite_bullet_targeted(
    bullet: str,
    keywords: list[str],
    keywords_to_preserve: list[str] | None = None,
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Rewrite a single resume bullet to naturally include specific keywords.

    Uses an ordered strategy: replace similar tech, reword, add at most one sentence, stop.
    Returns the original bullet unchanged on failure.

    Returns dict with keys:
      - bullet: rewritten (or original) bullet string
      - success: bool
      - error: str or None
      - duration_ms: int or None
      - keywords_used: list of keywords the model successfully wove in
      - keywords_skipped: list of keywords that did not fit (all input keywords on failure)
    """
    result: dict[str, Any] = {
        "bullet": bullet,
        "success": False,
        "error": None,
        "duration_ms": None,
        "keywords_used": [],
        "keywords_skipped": list(keywords),
    }
    if config.resume_llm_provider() != "ollama":
        return result
    if not bullet or not keywords:
        return result

    prompt_settings = load_c2_prompt_settings()
    prompt = prompts.build_rewrite_bullet_prompt(
        bullet=bullet,
        keywords=keywords,
        keywords_to_preserve=keywords_to_preserve,
        **_rewrite_prompt_policy_kwargs(prompt_settings, include_strategy=True),
    )
    start = time.perf_counter()
    try:
        kw_preview = ", ".join(keywords)[:40]
        _llm_log(f"rewrite bullet [{kw_preview}] [sending]", prompt, "", None)
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        _llm_log(f"rewrite bullet [{kw_preview}] [done]", prompt, raw, result["duration_ms"])
        if logger:
            logger.llm_call("rewrite_bullet", prompt, raw, result["duration_ms"], success=True)
        parsed = _extract_json_object(raw)
        text = (parsed.get("bullet") or "").strip()
        if text:
            model_used = parsed.get("keywords_used")
            model_skipped = parsed.get("keywords_skipped")
            claimed_used = (
                [str(k).strip() for k in model_used if str(k).strip()]
                if isinstance(model_used, list)
                else []
            )
            result["model_keywords_used"] = claimed_used
            result["model_keywords_skipped"] = (
                [str(k).strip() for k in model_skipped if str(k).strip()]
                if isinstance(model_skipped, list)
                else []
            )
            claimed_used, claimed_skipped = _clean_keyword_outcome(
                keywords,
                claimed_used,
                result["model_keywords_skipped"],
            )
            result["model_keywords_used"] = claimed_used
            result["model_keywords_skipped"] = claimed_skipped

            try:
                validation = validate_rewrite_with_ollama(
                    original=bullet,
                    rewritten=text,
                    requested_keywords=keywords,
                    logger=logger,
                )
            except Exception as exc:
                validation = {
                    "accepted": False,
                    "keywords_supported": [],
                    "keywords_rejected": list(keywords),
                    "reason": str(exc) or exc.__class__.__name__,
                }
            result["validation"] = validation
            if not validation["accepted"]:
                result["bullet"] = bullet
                result["success"] = False
                result["error"] = "rewrite_validation_failed"
                result["keywords_used"] = []
                result["keywords_skipped"] = list(keywords)
                return result

            used, skipped = _derive_keyword_outcome(
                keywords,
                validation.get("keywords_supported") or [],
                validation.get("keywords_rejected") or [],
            )
            if not used:
                result["bullet"] = bullet
                result["success"] = False
                result["error"] = "rewrite_validation_failed"
                result["keywords_used"] = []
                result["keywords_skipped"] = list(keywords)
                return result

            result["bullet"] = restore_textbf_from_original(bullet, text)
            result["success"] = True
            result["keywords_used"] = used
            result["keywords_skipped"] = skipped
    except Exception as exc:
        result["error"] = str(exc) or exc.__class__.__name__
        result["duration_ms"] = (
            int((time.perf_counter() - start) * 1000) if "start" in locals() else None
        )
        _llm_log("rewrite bullet [ERROR]", prompt, str(exc), result["duration_ms"])
        if logger:
            logger.llm_call(
                "rewrite_bullet",
                prompt,
                str(exc),
                result["duration_ms"],
                success=False,
                error=result["error"],
            )
    return result


def enrich_with_ollama_if_enabled(
    *,
    title: str,
    description: str,
    classification: dict,
    keywords: dict,
    logger: PipelineLogger | None = None,
) -> tuple[dict, dict, dict]:
    """When backend is ollama, ask the model for jd_usable + grounded keywords.

    On any failure, returns the original classification/keywords and ollama_enriched=False.
    """
    meta: dict = {
        "ollama_enriched": False,
        "error": None,
        "model": config.ollama_model_name(),
        "duration_ms": None,
    }
    if config.resume_llm_provider() != "ollama":
        return classification, keywords, meta
    try:
        prompt = _build_user_prompt(
            title,
            description,
            role_family=str(classification.get("role_family") or ""),
            job_level=str(classification.get("job_level") or ""),
        )
        if config.LOG_LLM_IO:
            limit = max(1, int(config.LOG_LLM_MAX_CHARS))
            meta["prompt_text"] = prompt[:limit]
        meta["description_len"] = len(description or "")
        meta["prompt_excerpt_len"] = len(build_jd_prompt_excerpt(description, 4500))
        _llm_log("call 1/3: keywords [sending]", prompt, "", None)
        start = time.perf_counter()
        content = _ollama_chat(prompt)
        meta["duration_ms"] = int((time.perf_counter() - start) * 1000)
        _llm_log("call 1/3: keywords [done]", prompt, content, meta["duration_ms"])
        if logger:
            logger.llm_call("keyword_extract", prompt, content, meta["duration_ms"], success=True)
        if config.LOG_LLM_IO:
            limit = max(1, int(config.LOG_LLM_MAX_CHARS))
            meta["response_text"] = (content or "")[:limit]
        parsed = _extract_json_object(content)
        new_c, new_k = _apply_jd_keywords(parsed, classification=classification, keywords=keywords)
        meta["ollama_enriched"] = True
        meta["source"] = "keyword_extract"
        if isinstance(parsed.get("jd_usable"), bool):
            meta["jd_usable"] = parsed["jd_usable"]
        reason = parsed.get("jd_usable_reason")
        if isinstance(reason, str) and reason.strip():
            meta["jd_usable_reason"] = reason.strip()[:500]
        if isinstance(parsed.get("unsupported_target_role"), bool):
            meta["unsupported_target_role"] = parsed["unsupported_target_role"]
        unsupported_reason = parsed.get("unsupported_target_reason")
        if isinstance(unsupported_reason, str) and unsupported_reason.strip():
            meta["unsupported_target_reason"] = unsupported_reason.strip()[:500]
        return new_c, new_k, meta
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
        if meta.get("duration_ms") is None:
            meta["duration_ms"] = (
                int((time.perf_counter() - start) * 1000) if "start" in locals() else None
            )
        meta["error"] = str(exc) or exc.__class__.__name__
        if logger:
            logger.llm_call(
                "keyword_extract",
                _build_user_prompt(
                    title,
                    description,
                    role_family=str(classification.get("role_family") or ""),
                    job_level=str(classification.get("job_level") or ""),
                ),
                str(exc),
                meta["duration_ms"],
                success=False,
                error=meta["error"],
            )
        return classification, keywords, meta
    except (json.JSONDecodeError, ValueError, TypeError, KeyError) as exc:
        if meta.get("duration_ms") is None:
            meta["duration_ms"] = (
                int((time.perf_counter() - start) * 1000) if "start" in locals() else None
            )
        meta["error"] = str(exc) or exc.__class__.__name__
        if logger:
            logger.llm_call(
                "keyword_extract",
                _build_user_prompt(
                    title,
                    description,
                    role_family=str(classification.get("role_family") or ""),
                    job_level=str(classification.get("job_level") or ""),
                ),
                str(exc),
                meta["duration_ms"],
                success=False,
                error=meta["error"],
            )
        return classification, keywords, meta
