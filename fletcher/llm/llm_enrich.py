from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import TYPE_CHECKING, Any

from .. import config
from ..jobs.keyword_policy import KeywordKind, classify_keyword_policy
from . import prompt_templates as prompts

if TYPE_CHECKING:
    from ..pipeline_logger import PipelineLogger

_LOG_LLM = False  # per-call LLM noise suppressed; full trace printed by pipeline._print_trace

BLOCKED_IDE_KEYWORDS = {
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
}

SKILL_ADDITION_LIMIT = 3


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
    return _normalize_visible_text(keyword) in BLOCKED_IDE_KEYWORDS


def _clean_extracted_keywords(
    values: list[str],
    *,
    limit: int = prompts.KEYWORD_SELECTION_MAX_KEYWORDS,
) -> list[str]:
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


def keyword_visible_in_text(keyword: str, text: str) -> bool:
    """Return true when a requested keyword is visibly represented in text."""
    key = _normalize_visible_text(keyword)
    visible = _normalize_visible_text(text)
    if not key or not visible:
        return False
    allowed = [key]
    allowed.extend(_visible_action_phrases(key))
    return any(_normalize_visible_text(phrase) in visible for phrase in allowed)


def repair_rewrite_redundancy(text: str) -> str:
    """Fix small deterministic awkward phrases before validation."""
    return re.sub(
        r"\bKotlin microservices and backend services\b",
        "backend Kotlin microservices",
        text or "",
        flags=re.IGNORECASE,
    )


def validate_rewrite_with_ollama(
    *,
    original: str,
    rewritten: str,
    requested_keywords: list[str],
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return {
            "accepted": True,
            "keywords_supported": list(requested_keywords),
            "keywords_rejected": [],
            "reason": "validator_disabled",
        }

    prompt = prompts.build_validate_rewrite_prompt(
        original=original,
        rewritten=rewritten,
        requested_keywords=requested_keywords,
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


def repair_rewrite_with_ollama(
    *,
    original: str,
    rewritten: str,
    requested_keywords: list[str],
    validation: dict[str, Any],
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Ask the model for one safer rewrite after validation feedback."""
    result: dict[str, Any] = {
        "bullet": original,
        "success": False,
        "error": None,
        "duration_ms": None,
        "keywords_used": [],
        "keywords_skipped": list(requested_keywords),
    }
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    prompt = prompts.build_repair_rewrite_prompt(
        original=original,
        rewritten=rewritten,
        requested_keywords=requested_keywords,
        validation=validation,
    )
    start = time.perf_counter()
    try:
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        if logger:
            logger.llm_call("repair_rewrite", prompt, raw, result["duration_ms"], success=True)
        parsed = _extract_json_object(raw)
        text = (parsed.get("bullet") or "").strip()
        if text:
            used = _filter_requested_keywords(
                _dedupe_case(
                    parsed.get("keywords_used")
                    if isinstance(parsed.get("keywords_used"), list)
                    else []
                ),
                requested_keywords,
            )
            skipped = _filter_requested_keywords(
                _dedupe_case(
                    parsed.get("keywords_skipped")
                    if isinstance(parsed.get("keywords_skipped"), list)
                    else []
                ),
                requested_keywords,
            )
            result.update(
                {
                    "bullet": text,
                    "success": True,
                    "keywords_used": used,
                    "keywords_skipped": skipped
                    or [
                        kw
                        for kw in requested_keywords
                        if kw.lower() not in {u.lower() for u in used}
                    ],
                }
            )
    except Exception as exc:
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        result["error"] = str(exc) or exc.__class__.__name__
        if logger:
            logger.llm_call(
                "repair_rewrite",
                prompt,
                str(exc),
                result["duration_ms"],
                success=False,
                error=result["error"],
            )
    return result


def validate_summary_grounding(
    summary: str,
    candidate_context: str,
    keywords: list[str],
) -> dict[str, Any]:
    """Compatibility wrapper: summary quality belongs to the LLM validation prompt."""
    return {"accepted": True, "reasons": []}


def _ollama_chat(user_prompt: str, *, temperature: float = 0.1) -> str:
    host = config.OLLAMA_HOST
    model = config.OLLAMA_MODEL_NAME
    timeout = config.OLLAMA_TIMEOUT_SEC
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
    return prompts.keyword_selection_prompt()


def _build_user_prompt(
    title: str,
    description: str,
    *,
    role_family: str = "",
    job_level: str = "",
) -> str:
    return prompts.build_keyword_extract_prompt(
        title,
        description,
        role_family=role_family,
        job_level=job_level,
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


def infer_title_with_ollama(
    *,
    input_title: str,
    description: str,
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Infer the job title when deterministic title extraction is empty or suspicious."""
    result = {"title": "", "success": False, "error": None, "duration_ms": None}
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    prompt = prompts.build_infer_title_prompt(input_title, description)
    start = time.perf_counter()
    try:
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        if logger:
            logger.llm_call("infer_title", prompt, raw, result["duration_ms"], success=True)
        parsed = _extract_json_object(raw)
        title = str(parsed.get("title") or "").strip()
        if title:
            result["title"] = title[:120]
            result["success"] = True
    except Exception as exc:
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        result["error"] = str(exc) or exc.__class__.__name__
        if logger:
            logger.llm_call(
                "infer_title",
                prompt,
                str(exc),
                result["duration_ms"],
                success=False,
                error=result["error"],
            )
    return result


def analyze_job_fit_with_ollama(
    *,
    input_title: str,
    deterministic_title: str,
    description: str,
    missing_fields: list[str] | None = None,
    target_lane_policy: str = "",
    unsupported_examples: list[str] | None = None,
    allowed_role_families: list[str] | None = None,
    allowed_job_levels: list[str] | None = None,
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
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    target_lane_policy = (target_lane_policy or "").strip()
    missing_fields = missing_fields or ["title", "role_family", "job_level"]
    prompt = prompts.build_job_metadata_prompt(
        input_title=input_title or deterministic_title,
        description=description,
        missing_fields=missing_fields,
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
        if confidence < prompts.JOB_METADATA_MIN_CONFIDENCE:
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
    if config.DEFAULT_MODEL_BACKEND != "ollama":
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
                    limit=prompts.KEYWORD_SELECTION_MAX_KEYWORDS,
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


def classify_job_with_ollama(
    *,
    title: str,
    description: str,
    allowed_role_families: list[str] | None = None,
    allowed_job_levels: list[str] | None = None,
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Classify role family and level when deterministic classification is weak."""
    result: dict[str, Any] = {"success": False, "error": None, "duration_ms": None}
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    prompt = prompts.build_classify_job_prompt(
        title=title,
        description=description,
        allowed_role_families=allowed_role_families,
        allowed_job_levels=allowed_job_levels,
    )
    start = time.perf_counter()
    try:
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        if logger:
            logger.llm_call("classify_job", prompt, raw, result["duration_ms"], success=True)
        parsed = _extract_json_object(raw)
        family = str(parsed.get("role_family") or "").strip().lower()
        level = str(parsed.get("job_level") or "").strip().lower()
        if family and level:
            result.update(
                {
                    "success": True,
                    "role_family": family,
                    "job_level": level,
                    "confidence": float(parsed.get("confidence") or 0.7),
                    "reasons": parsed.get("reasons")
                    if isinstance(parsed.get("reasons"), list)
                    else [],
                }
            )
    except Exception as exc:
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        result["error"] = str(exc) or exc.__class__.__name__
        if logger:
            logger.llm_call(
                "classify_job",
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
    if config.DEFAULT_MODEL_BACKEND != "ollama" or not keywords:
        return result
    requested_l = {keyword.lower() for keyword in _dedupe_case(keywords)}

    def build_prompt(*, retry: bool = False) -> str:
        return prompts.build_summary_keyword_filter_prompt(
            keywords=keywords,
            candidate_context=candidate_context,
            job_title=job_title,
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
                    "summary_keyword_filter", prompt, raw, result["duration_ms"], success=True
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
    if config.DEFAULT_MODEL_BACKEND != "ollama" or not keywords:
        return result
    required_categories = ("languages", "frameworks", "developer_tools")
    requested_l = {keyword.lower() for keyword in _dedupe_case(keywords)}

    def build_prompt(*, retry: bool = False) -> str:
        return prompts.build_skill_bucket_prompt(
            keywords=keywords,
            existing_skills=existing_skills,
            skill_addition_limit=SKILL_ADDITION_LIMIT,
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
            missing_keys = [
                key
                for key, value in (("additions", additions_raw), ("ignored", ignored_raw))
                if not isinstance(value, list)
            ]
            raw_values = []
            if isinstance(additions_raw, list):
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
                    "bucket_skill_keywords", prompt, raw, result["duration_ms"], success=True
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
            if isinstance(additions_raw, list):
                for item in additions_raw:
                    if not isinstance(item, dict):
                        continue
                    keyword = str(item.get("keyword") or "").strip()
                    category = str(item.get("category") or "").strip()
                    if category not in required_categories:
                        continue
                    filtered = _filter_requested_keywords([keyword], keywords)
                    if filtered:
                        additions.append((filtered[0], category))
            seen_additions: set[str] = set()
            for keyword, category in additions:
                key = keyword.lower()
                if key in seen_additions:
                    continue
                seen_additions.add(key)
                if (
                    sum(len(result[bucket]) for bucket in required_categories)
                    >= SKILL_ADDITION_LIMIT
                ):
                    break
                result[category].append(keyword)
            added_l = {
                keyword.lower() for bucket in required_categories for keyword in result[bucket]
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


def should_continue_after_low_rag_with_ollama(
    *,
    title: str,
    description: str,
    keywords: list[str],
    rag_scores: list[dict[str, Any]],
    target_lane_policy: str = "",
    unsupported_examples: list[str] | None = None,
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """For queued jobs, decide whether weak RAG means the role is outside target lane."""
    result: dict[str, Any] = {
        "continue_tailoring": True,
        "unsupported_target_role": False,
        "reason": "",
        "success": False,
        "error": None,
        "duration_ms": None,
    }
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    target_lane_policy = (target_lane_policy or "").strip()
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
    prompt = prompts.build_low_rag_continue_prompt(
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
        continue_tailoring = parsed.get("continue_tailoring")
        unsupported = parsed.get("unsupported_target_role")
        if not isinstance(continue_tailoring, bool) or not isinstance(unsupported, bool):
            raise ValueError("continue_tailoring and unsupported_target_role must be booleans")
        reason = str(parsed.get("reason") or "").strip()[:500]
        if not target_lane_policy:
            continue_tailoring = True
            unsupported = False
            reason = ""
        result.update(
            {
                "continue_tailoring": continue_tailoring,
                "unsupported_target_role": unsupported,
                "reason": reason,
                "success": True,
            }
        )
        if logger:
            logger.llm_call(
                "low_rag_continue_check", prompt, raw, result["duration_ms"], success=True
            )
    except Exception as exc:
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        result["error"] = str(exc) or exc.__class__.__name__
        if logger:
            logger.llm_call(
                "low_rag_continue_check",
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
    result = {"accepted": True, "reasons": [], "success": False, "duration_ms": None, "error": None}
    if config.DEFAULT_MODEL_BACKEND != "ollama" or not summary:
        return result
    prompt = prompts.build_summary_validation_prompt(
        summary=summary,
        candidate_context=candidate_context,
        keywords=keywords,
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
        if not isinstance(exc, (json.JSONDecodeError, ValueError, TypeError, KeyError)):
            return result
        retry_prompt = prompts.build_summary_validation_retry_prompt(
            summary=summary,
            candidate_context=candidate_context,
            keywords=keywords,
        )
        retry_start = time.perf_counter()
        try:
            raw = _ollama_chat(retry_prompt)
            retry_duration_ms = int((time.perf_counter() - retry_start) * 1000)
            if logger:
                logger.llm_call(
                    "validate_summary_json_retry",
                    retry_prompt,
                    raw,
                    retry_duration_ms,
                    success=True,
                )
            parsed = _extract_json_object(raw)
            reasons = parsed.get("reasons")
            result.update(
                {
                    "accepted": bool(parsed.get("accepted")),
                    "reasons": reasons if isinstance(reasons, list) else [],
                    "success": True,
                    "error": None,
                    "retry": "json_compact",
                    "duration_ms": (result["duration_ms"] or 0) + retry_duration_ms,
                }
            )
        except Exception as retry_exc:
            retry_duration_ms = int((time.perf_counter() - retry_start) * 1000)
            retry_error = str(retry_exc) or retry_exc.__class__.__name__
            result["retry_error"] = retry_error
            result["duration_ms"] = (result["duration_ms"] or 0) + retry_duration_ms
            if logger:
                logger.llm_call(
                    "validate_summary_json_retry",
                    retry_prompt,
                    retry_error,
                    retry_duration_ms,
                    success=False,
                    error=retry_error,
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
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    if not candidate_context or not job_title:
        return result

    summary_keywords = _dedupe_case(keywords)
    prompt = prompts.build_summary_generation_prompt(
        candidate_context=candidate_context,
        job_title=job_title,
        keywords=summary_keywords,
        existing_summary=existing_summary,
        line_feedback=line_feedback,
        role_family=role_family,
        job_level=job_level,
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
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    if not bullet or not keywords:
        return result

    prompt = prompts.build_rewrite_bullet_prompt(
        bullet=bullet,
        keywords=keywords,
        keywords_to_preserve=keywords_to_preserve,
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
                result["initial_validation"] = validation
                repair = repair_rewrite_with_ollama(
                    original=bullet,
                    rewritten=text,
                    requested_keywords=keywords,
                    validation=validation,
                    logger=logger,
                )
                result["repair"] = repair
                if repair.get("success"):
                    repair_text = str(repair.get("bullet") or "").strip()
                    repair_used = list(repair.get("keywords_used") or [])
                    repair_validation = validate_rewrite_with_ollama(
                        original=bullet,
                        rewritten=repair_text,
                        requested_keywords=keywords,
                        logger=logger,
                    )
                    result["repair_validation"] = repair_validation
                    if repair_validation["accepted"]:
                        used, skipped = _derive_keyword_outcome(
                            keywords,
                            repair_validation.get("keywords_supported") or repair_used,
                            repair_validation.get("keywords_rejected") or [],
                        )
                        if used:
                            result["bullet"] = repair_text
                            result["success"] = True
                            result["validation"] = repair_validation
                            result["keywords_used"] = used
                            result["keywords_skipped"] = skipped
                            return result
                _used, skipped = _derive_keyword_outcome(
                    keywords,
                    validation.get("keywords_supported") or [],
                    validation.get("keywords_rejected") or [],
                )
                result["bullet"] = bullet
                result["success"] = False
                result["error"] = "rewrite_validation_failed"
                result["keywords_used"] = []
                result["keywords_skipped"] = skipped or list(keywords)
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
                result["keywords_skipped"] = skipped or list(keywords)
                return result

            result["bullet"] = text
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
        "model": config.OLLAMA_MODEL_NAME,
        "duration_ms": None,
    }
    if config.DEFAULT_MODEL_BACKEND != "ollama":
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
