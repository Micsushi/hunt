from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import TYPE_CHECKING, Any

from .. import config
from ..jobs.keyword_policy import KeywordKind, classify_keyword_policy

if TYPE_CHECKING:
    from ..pipeline_logger import PipelineLogger

_LOG_LLM = False  # per-call LLM noise suppressed; full trace printed by pipeline._print_trace

DOMAIN_KEYWORDS = {
    "real-time threat intelligence",
    "threat intelligence",
    "siem",
    "xdr",
    "itdr",
    "mdr",
    "ai-driven platform",
}

DIRECT_SUPPORT_KEYWORDS = DOMAIN_KEYWORDS | {
    "real time threat intelligence",
    "ai driven platform",
    "data exploration",
    "data pipeline",
    "data pipelines",
    "model training",
    "modelops",
    "productionalize",
    "operationalize",
    "big data technologies",
    "monitor data performance",
}

AMBIGUOUS_VALIDATION_KEYWORDS = DOMAIN_KEYWORDS | {
    "infrastructure as code",
    "cloud infrastructure",
    "cloud platforms",
    "data pipelines",
}

SUMMARY_BANNED_TONE = (
    "motivated",
    "eager",
    "passionate",
    "aspiring",
    "contribute immediately",
    "diverse programming skills",
)


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


def categorize_keyword(keyword: str) -> str:
    if classify_keyword_policy(keyword).kind == KeywordKind.DOMAIN:
        return "domain"
    return "tech"


def keyword_requires_direct_support(keyword: str) -> bool:
    policy = classify_keyword_policy(keyword)
    return (
        policy.requires_same_bullet_evidence
        or _normalize_visible_text(keyword) in DIRECT_SUPPORT_KEYWORDS
    )


def _needs_ambiguous_validation(keywords: list[str]) -> bool:
    return any(
        (keyword or "").strip().lower() in AMBIGUOUS_VALIDATION_KEYWORDS for keyword in keywords
    )


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


def validate_claimed_keywords_present(
    *,
    rewritten: str,
    requested_keywords: list[str],
    claimed_used: list[str],
) -> dict[str, Any]:
    """Mechanically report whether claimed used keywords visibly appear.

    This is intentionally only a diagnostic. The caller can use LLM rewrite
    validation for conceptual matches such as full-stack architecture versus
    full stack development.
    """
    requested_l = {kw.lower() for kw in requested_keywords}
    missing: list[str] = []
    present: list[str] = []
    for keyword in claimed_used:
        key = (keyword or "").strip().lower()
        if not key:
            continue
        if key not in requested_l:
            missing.append(keyword)
            continue
        if not keyword_visible_in_text(keyword, rewritten):
            missing.append(keyword)
        else:
            present.append(keyword)
    return {
        "accepted": not missing,
        "missing": _dedupe_case(missing),
        "present": _dedupe_case(present),
    }


def repair_rewrite_redundancy(text: str) -> str:
    """Fix small deterministic awkward phrases before validation."""
    return re.sub(
        r"\bKotlin microservices and backend services\b",
        "backend Kotlin microservices",
        text or "",
        flags=re.IGNORECASE,
    )


def _has_ci_cd_evidence(text: str) -> bool:
    visible = _normalize_visible_text(text)
    return any(
        phrase in visible
        for phrase in (
            "ci cd",
            "deployment",
            "deployments",
            "bitbucket pipelines",
            "ecr",
            "kubernetes",
            "release",
            "pipeline",
            "pipelines",
        )
    )


def _has_data_platform_evidence(text: str) -> bool:
    visible = _normalize_visible_text(text)
    return any(
        phrase in visible
        for phrase in (
            "databricks",
            "data pipeline",
            "data pipelines",
            "spark",
            "snowflake",
            "etl",
            "warehouse",
            "lakehouse",
        )
    )


def _has_cloud_resource_conflict(original: str, rewritten: str, keyword: str) -> bool:
    key = _normalize_visible_text(keyword)
    original_v = _normalize_visible_text(original)
    rewritten_v = _normalize_visible_text(rewritten)
    if key not in {"azure", "azure cloud", "azure devops"}:
        return False
    if key == "azure devops" and _has_ci_cd_evidence(original):
        return False
    has_aws_resource = any(
        phrase in original_v for phrase in ("aws", "s3", "ecr", "dynamodb", "aurora")
    )
    has_rewritten_azure = "azure" in rewritten_v
    still_mentions_aws_resource = any(
        phrase in rewritten_v for phrase in ("aws", "s3", "ecr", "dynamodb", "aurora")
    )
    return has_aws_resource and has_rewritten_azure and still_mentions_aws_resource


def _unsupported_tool_substitution(original: str, rewritten: str, keyword: str) -> str | None:
    key = _normalize_visible_text(keyword)
    if _has_cloud_resource_conflict(original, rewritten, keyword):
        return "cross_vendor_cloud_resource_conflict"
    if key == "azure devops":
        return None if _has_ci_cd_evidence(original) else "unsupported_tool_substitution"
    if key == "databricks":
        if _has_data_platform_evidence(original):
            return None
        return "unsupported_tool_substitution"
    if key == "datadog":
        return None
    return None


def validate_rewrite_grounding(
    *,
    original: str,
    rewritten: str,
    requested_keywords: list[str],
) -> dict[str, Any]:
    rewritten_l = (rewritten or "").lower()
    rejected: list[str] = []
    supported: list[str] = []
    reasons: list[str] = []

    if "microservices and backend services" in rewritten_l:
        rejected.extend([kw for kw in requested_keywords if kw.lower() == "backend services"])
        reasons.append("redundant_backend_services")

    for keyword in requested_keywords:
        key = (keyword or "").strip().lower()
        if not key:
            continue
        policy = classify_keyword_policy(keyword)
        tool_issue = _unsupported_tool_substitution(original, rewritten, keyword)
        if tool_issue and keyword_visible_in_text(keyword, rewritten):
            rejected.append(keyword)
            reasons.append(f"{tool_issue}:{keyword}")
            continue
        if keyword_requires_direct_support(keyword) and not keyword_visible_in_text(
            keyword, original
        ):
            if keyword_visible_in_text(keyword, rewritten):
                rejected.append(keyword)
                reason_type = (
                    "unsupported_domain_keyword"
                    if policy.kind == KeywordKind.DOMAIN
                    else "unsupported_policy_keyword"
                )
                reasons.append(f"{reason_type}:{keyword}")
            continue
        if keyword_visible_in_text(keyword, rewritten):
            supported.append(keyword)

    rejected = _dedupe_case(rejected)
    rejected_l = {item.lower() for item in rejected}
    supported = [kw for kw in _dedupe_case(supported) if kw.lower() not in rejected_l]
    return {
        "accepted": not rejected,
        "keywords_supported": supported,
        "keywords_rejected": rejected,
        "reasons": reasons,
    }


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

    prompt = (
        "Validate whether a rewritten resume bullet preserves the original meaning while adding useful resume keywords.\n"
        f"Original bullet: {original}\n"
        f"Rewritten bullet: {rewritten}\n"
        f"Requested keywords: {', '.join(requested_keywords)}\n"
        "Judge each requested keyword independently. A rewritten bullet may be partially "
        "supported: put supported keywords in keywords_supported and unsupported keywords "
        "in keywords_rejected.\n"
        "Accept adjacent framing when it stays in the same work context, same outcome, "
        "and coherent technology/workflow family. The keyword does not need to appear "
        "explicitly in the original bullet if the rewrite still describes the same kind "
        "of work and would not mislead an interviewer about what happened.\n"
        "Reject when the rewrite changes the meaning of the bullet, changes the project "
        "or business domain, invents a new responsibility, claims a different outcome, "
        "or creates an incoherent relationship between technologies, vendors, resources, "
        "or workflows.\n"
        "Preserve the bullet's original format and order where possible: outcome or "
        "metric first, then action, method, tool, or scope. Reject lazy keyword stuffing "
        "that appends a phrase without fitting the sentence naturally.\n"
        "Reject awkward resume phrasing where a keyword is bolted on instead of integrated "
        "naturally, including vague constructions such as 'utilizing X' or '[keyword] "
        "stability' when the phrase would sound strange to an interviewer.\n"
        "Do not reject solely because the keyword is not explicit in the original text. "
        "Reject only when the new wording no longer makes sense for the original context "
        "or materially overstates the candidate's work.\n"
        'Return only: {"accepted": boolean, "keywords_supported": [...], '
        '"keywords_rejected": [...], "reason": "..."}'
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
    rejected = validation.get("keywords_rejected") or []
    supported = validation.get("keywords_supported") or []
    retry_keywords = [kw for kw in requested_keywords if kw not in rejected]
    if not retry_keywords:
        retry_keywords = list(requested_keywords)
    prompt = (
        "Repair this resume bullet rewrite after validation feedback.\n"
        f"Original bullet: {original}\n"
        f"Rejected rewrite: {rewritten}\n"
        f"Requested keywords: {', '.join(requested_keywords)}\n"
        f"Supported keywords from validation: {', '.join(supported)}\n"
        f"Rejected keywords from validation: {', '.join(rejected)}\n"
        f"Validation reason: {validation.get('reason') or validation.get('reasons') or ''}\n"
        "Write one truthful bullet in the same Google XYZ-style structure as the original: "
        "preserve outcome/metric, action, method, tools, and scope. Use only keywords "
        "that fit the same work context. Skip keywords that would change the meaning, "
        "invent a different domain, or create incoherent technology relationships.\n"
        'Return only: {"bullet": "...", "keywords_used": [...], "keywords_skipped": [...]}'
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
    """Mechanically reject only banned tone; semantic grounding is an LLM check."""
    summary_l = (summary or "").lower()
    reasons: list[str] = []
    for phrase in SUMMARY_BANNED_TONE:
        if phrase in summary_l:
            reasons.append(f"banned_tone:{phrase}")
    return {"accepted": not reasons, "reasons": reasons}


def _ollama_chat(user_prompt: str) -> str:
    host = config.OLLAMA_HOST
    model = config.OLLAMA_MODEL_NAME
    timeout = config.OLLAMA_TIMEOUT_SEC
    payload = {
        "model": model,
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.1},
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a careful resume-tailoring assistant. "
                    "Return strict JSON only, follow the requested schema exactly, "
                    "and prefer skipping or rejecting unsupported claims over guessing."
                ),
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


def _keyword_selection_instructions() -> str:
    return """List 0 to 30 resume-tailoring keywords that **appear verbatim** in the title or description (same spelling; minor case differences ok).

These keywords are intended to be added to resume bullets, the professional summary, or the Technical Skills section when later resume matching supports them.
The title, role family, seniority, education, credentials, certifications, licenses, and other metadata are handled separately by the pipeline, so do not repeat them as keywords.

Only include signals that are one of:
- concrete tech stack or data stack terms: languages, frameworks, libraries, cloud platforms, databases, developer tools, data tools
- concrete technical methods or workflows: testing, CI/CD, code reviews, model deployment, data preprocessing, dashboards, security scanning
- concrete candidate quality/process traits that are explicitly requested: leadership, ownership, collaboration, communication, testing rigor, analytical thinking, user empathy

Fill the keyword slots in this priority order:
1. named technologies, tools, platforms, databases, frameworks, and languages
2. concrete technical methods/workflows
3. requested qualities/process traits

Do not include job titles, role labels, seniority labels, employment types, program names, departments, locations, credentials, certifications, licenses, education fields, company metadata, compensation, executive visibility, hiring logistics, or spoken-language nice-to-haves. Examples to exclude: Software Engineer, Intermediate, Senior, Bachelor, P.Eng, AWS Certified.
Skip generic deliverables and vague nouns such as reports, diagrams, flow charts, documentation, analysis, validation, interpretation, data sources, or findings unless paired with a concrete technical method/tool from the JD.
Do not invent anything not in the text. If the posting is not usable, return an empty keyword list."""


def _build_user_prompt(title: str, description: str) -> str:
    desc_truncated = (description or "")[:4000]
    return f"""Job title: {title}
Job description:
{desc_truncated or "(empty)"}

Answer two questions using only the title and description above.

1) Is this posting usable for tailoring a resume? Usable means there is enough concrete content (not just "apply on company site", not empty, not a useless stub). Scrapes that lost the real JD should be marked not usable.

2) {_keyword_selection_instructions()}

Return a single JSON object with exactly these keys:
- "jd_usable": boolean
- "jd_usable_reason": string (one short sentence)
- "keywords": array of 0 to 30 strings

No other keys."""


def _apply_jd_keywords(
    parsed: dict[str, Any],
    *,
    classification: dict,
    keywords: dict,
) -> tuple[dict, dict]:
    """Merge Ollama jd_usable + keywords into classification and keywords dicts."""
    jd_usable = parsed.get("jd_usable")
    if not isinstance(jd_usable, bool):
        raise ValueError("jd_usable must be a boolean")

    reason = parsed.get("jd_usable_reason")
    reason_str = reason.strip() if isinstance(reason, str) else ""

    raw_list = parsed.get("keywords")
    if not isinstance(raw_list, list):
        raise ValueError("keywords must be an array")
    terms: list[str] = []
    seen: set[str] = set()
    for item in raw_list:
        if not isinstance(item, str):
            continue
        s = item.strip()
        if not s or s.lower() in seen:
            continue
        seen.add(s.lower())
        terms.append(s)
        if len(terms) >= 30:
            break

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

    new_k = dict(keywords)
    new_k["must_have_terms"] = terms
    new_k["nice_to_have_terms"] = []
    new_k["tools_and_technologies"] = list(terms)
    new_k["domain_terms"] = []
    return new_c, new_k


def classify_keyword_routes_with_ollama(
    *,
    keywords: list[str],
    job_title: str,
    resume_context: str = "",
    role_family: str = "",
    job_level: str = "",
    logger: PipelineLogger | None = None,
) -> dict[str, dict[str, str]]:
    """Ask Ollama to filter JD keywords without judging candidate evidence."""
    if config.DEFAULT_MODEL_BACKEND != "ollama" or not keywords:
        return {}
    valid_routes = {"rewrite", "summary", "skills_only", "ignore"}
    valid_kinds = {kind.value for kind in KeywordKind}
    requested_by_lower = {keyword.lower(): keyword for keyword in _dedupe_case(keywords)}
    prompt = (
        "Filter job-description keywords for a resume tailoring pipeline.\n"
        f"Job title: {job_title or '(empty)'}\n"
        f"Role family: {role_family or '(unknown)'}\n"
        f"Job level: {job_level or '(unknown)'}\n"
        f"Signals to route: {json.dumps(_dedupe_case(keywords))}\n"
        "Do not use candidate resume evidence here. Only judge whether each signal is the kind of keyword we would want the later RAG step to match into bullets, summary, or skills.\n"
        "For each signal, choose exactly one route:\n"
        "- rewrite: keep for RAG matching. Use for concrete tech stack, tools, languages, frameworks, libraries, data/security/dev tools, and concrete technical methods or workflows.\n"
        "- summary: keep out of bullet rewrite but allow summary positioning. Use for concrete personality/process traits such as communication, ownership, collaboration, leadership, analytical thinking, and stakeholder alignment.\n"
        "- skills_only: concrete named technology/tool/database/framework that should only be considered for the Technical Skills section.\n"
        "- ignore: job title, employment type, program name, department, location, compensation, credential, education field, company metadata, executive visibility, unsupported spoken language, generic business use case, or vague deliverable.\n"
        "Prefer ignore for business/domain phrases that are not tech stack, technical workflow, or requested candidate trait.\n"
        "Never decide whether the candidate has experience with the signal. RAG and validation do that later.\n"
        "Use kind values: tech, tool, language, framework, process, quality, domain, role_title, education, logistics, org_metadata, language_requirement, ignore.\n"
        'Return only: {"routes": [{"keyword": "...", "route": "...", "kind": "...", "reason": "..."}]}'
    )
    start = time.perf_counter()
    raw = ""
    try:
        raw = _ollama_chat(prompt)
        duration_ms = int((time.perf_counter() - start) * 1000)
        parsed = _extract_json_object(raw)
        raw_routes = parsed.get("routes", [])
        if logger:
            logger.llm_call("keyword_policy_route", prompt, raw, duration_ms, success=True)
        if isinstance(raw_routes, dict):
            raw_routes = [
                {"keyword": keyword, **detail}
                for keyword, detail in raw_routes.items()
                if isinstance(detail, dict)
            ]
        routes: dict[str, dict[str, str]] = {}
        if not isinstance(raw_routes, list):
            return {}
        for item in raw_routes:
            if not isinstance(item, dict):
                continue
            keyword_key = str(item.get("keyword") or "").strip().lower()
            original_keyword = requested_by_lower.get(keyword_key)
            route = str(item.get("route") or "").strip().lower()
            kind = str(item.get("kind") or "").strip().lower()
            if not original_keyword or route not in valid_routes or kind not in valid_kinds:
                continue
            routes[original_keyword] = {
                "route": route,
                "kind": kind,
                "reason": str(item.get("reason") or "").strip()[:240],
            }
        return routes
    except Exception as exc:
        duration_ms = int((time.perf_counter() - start) * 1000)
        if logger:
            logger.llm_call(
                "keyword_policy_route",
                prompt,
                raw or str(exc),
                duration_ms,
                success=False,
                error=str(exc) or exc.__class__.__name__,
            )
        return {}


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
    prompt = (
        "Extract the actual role title from this job posting. "
        "Do not return metadata headings, locations, functions, departments, company names, or section headings. "
        "If no real role title is present, return an empty string.\n"
        f"Input title: {input_title or '(empty)'}\n"
        f"Job description: {(description or '')[:3500]}\n"
        'Return only: {"title": "..."}'
    )
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
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Infer title, classify role, and detect mismatch in one model judgment."""
    result: dict[str, Any] = {
        "success": False,
        "title": deterministic_title or "",
        "role_family": "",
        "job_level": "",
        "mismatch": False,
        "mismatch_reason": "",
        "jd_usable": None,
        "jd_usable_reason": "",
        "keywords": [],
        "error": None,
        "duration_ms": None,
    }
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    prompt = (
        "Analyze this job posting for resume tailoring in one pass.\n"
        f"Requested/input title: {input_title or '(empty)'}\n"
        f"Deterministic title guess: {deterministic_title or '(empty)'}\n"
        f"Job description: {(description or '')[:4500]}\n"
        "Return the actual role title from the JD, role_family, job_level, whether the JD is clearly mismatched against the requested title, whether the JD is usable for tailoring, and filtered resume-tailoring keywords. "
        "Mark mismatch true for clear wrong-role cases, such as requested software engineer but detected chief/director/VP/product manager, requested PM but detected unrelated engineering role, or an executive/chief/VP/head/C-level posting when the requested title does not explicitly ask for executive leadership. "
        "When the requested title is empty, treat computer-related roles as supported: software, data, PM, firmware, cloud infrastructure, network engineering, security engineering, DevOps, SRE, IT systems, platform, infrastructure, or closely related technical/product roles. "
        "Do not mark mismatch for Network Engineer, Cloud Engineer, Infrastructure Engineer, Security Engineer, DevOps Engineer, SRE, Systems Engineer, or similar computer/IT roles just because the role_family is general. "
        "Only mark mismatch true when the JD is clearly outside computer, IT, technical, or product work. "
        "Do not mark mismatch just because the title was empty or generic.\n"
        "Allowed role_family values: software, data, pm, firmware, infrastructure, general.\n"
        "Allowed job_level values: intern, new_grad, junior, mid, senior, staff, principal, manager, director, executive, unknown.\n"
        "For jd_usable: usable means there is enough concrete content to tailor a resume from, not just an empty/stub scrape.\n"
        f"{_keyword_selection_instructions()}\n"
        'Return only: {"title": "...", "role_family": "...", "job_level": "...", "mismatch": boolean, "mismatch_reason": "...", "confidence": 0.0, "jd_usable": boolean, "jd_usable_reason": "...", "keywords": ["..."]}'
    )
    start = time.perf_counter()
    try:
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        if logger:
            logger.llm_call("analyze_job_fit", prompt, raw, result["duration_ms"], success=True)
        parsed = _extract_json_object(raw)
        raw_keywords = parsed.get("keywords")
        keywords = (
            _dedupe_case(
                [
                    keyword.strip()
                    for keyword in raw_keywords
                    if isinstance(keyword, str) and keyword.strip()
                ]
            )[:30]
            if isinstance(raw_keywords, list)
            else []
        )
        jd_usable = parsed.get("jd_usable")
        if not isinstance(jd_usable, bool):
            jd_usable = bool((description or "").strip()) and not bool(parsed.get("mismatch"))
        if not jd_usable:
            keywords = []
        result.update(
            {
                "success": True,
                "title": str(parsed.get("title") or deterministic_title or "").strip()[:120],
                "role_family": str(parsed.get("role_family") or "").strip().lower(),
                "job_level": str(parsed.get("job_level") or "").strip().lower(),
                "mismatch": bool(parsed.get("mismatch")),
                "mismatch_reason": str(parsed.get("mismatch_reason") or "").strip()[:240],
                "confidence": float(parsed.get("confidence") or 0.7),
                "jd_usable": jd_usable,
                "jd_usable_reason": str(parsed.get("jd_usable_reason") or "").strip()[:500],
                "keywords": keywords,
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


def classify_job_with_ollama(
    *,
    title: str,
    description: str,
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Classify role family and level when deterministic classification is weak."""
    result: dict[str, Any] = {"success": False, "error": None, "duration_ms": None}
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    prompt = (
        "Classify this job for resume tailoring.\n"
        f"Title: {title or '(empty)'}\n"
        f"Description: {(description or '')[:3500]}\n"
        "Allowed role_family values: software, data, pm, firmware, infrastructure, general.\n"
        "Allowed job_level values: intern, new_grad, junior, mid, senior, staff, principal, manager, director, executive, unknown.\n"
        "Use executive only for chief, VP, head-of, C-level, or equivalent leadership roles.\n"
        'Return only: {"role_family": "...", "job_level": "...", "confidence": 0.0, "reasons": ["..."]}'
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
        retry_line = (
            "Previous output used terms outside Candidate keywords. Use only exact items from Candidate keywords.\n"
            if retry
            else ""
        )
        return (
            "Choose which job-description signals can be truthfully used in a resume summary.\n"
            f"Job title: {job_title or '(empty)'}\n"
            f"Candidate evidence: {(candidate_context or '')[:3000]}\n"
            f"Candidate keywords: {json.dumps(keywords)}\n"
            f"{retry_line}"
            "Include only exact Candidate keywords that fit the evidence naturally. Exclude unsupported domain claims and awkward stuffing. "
            "If a term is useful but should be phrased more generally, include the original term only if it can appear truthfully. "
            "Do not add new keywords or synonyms.\n"
            'Return only: {"included": [...], "excluded": [...], "reason": "..."}'
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
                included_l = {kw.lower() for kw in included}
                excluded = [kw for kw in excluded if kw.lower() not in included_l]
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
    required_keys = ("languages", "frameworks", "developer_tools", "ignored")
    requested_l = {keyword.lower() for keyword in _dedupe_case(keywords)}

    def build_prompt(*, retry: bool = False) -> str:
        retry_line = (
            "Previous output was invalid. Return all four keys and use only exact Candidate keywords.\n"
            if retry
            else ""
        )
        return (
            "Classify which keywords should be added to the resume Technical Skills section.\n"
            f"Existing skills: {json.dumps(existing_skills)}\n"
            f"Candidate keywords: {json.dumps(keywords)}\n"
            f"{retry_line}"
            "Only add a keyword if the keyword itself belongs in a resume Technical Skills section. "
            "Good additions are programming languages, frameworks, libraries, platforms, developer tools, databases, cloud tools, operating-system skills, protocols, or concrete technical skill phrases such as Linux scripting. "
            "Do not add job titles, business process phrases, qualities, responsibilities, education fields, logistics, business-domain phrases, or vague concepts. "
            "Do not rewrite or generalize a phrase into a skill. If uncertain, put it in ignored. "
            "Return all four keys: languages, frameworks, developer_tools, ignored.\n"
            'Return only: {"languages": [...], "frameworks": [...], "developer_tools": [...], "ignored": [...]}'
        )

    for attempt in range(2):
        prompt = build_prompt(retry=attempt > 0)
        start = time.perf_counter()
        try:
            raw = _ollama_chat(prompt)
            result["duration_ms"] = int((time.perf_counter() - start) * 1000)
            parsed = _extract_json_object(raw)
            missing_keys = [key for key in required_keys if not isinstance(parsed.get(key), list)]
            raw_values = []
            for key in required_keys:
                if isinstance(parsed.get(key), list):
                    raw_values.extend(str(value).strip() for value in parsed[key])
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
            for key in required_keys:
                result[key] = _filter_requested_keywords(
                    _dedupe_case(parsed.get(key) if isinstance(parsed.get(key), list) else []),
                    keywords,
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


def validate_summary_with_ollama(
    *,
    summary: str,
    candidate_context: str,
    keywords: list[str],
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    """Validate summary truthfulness with the model."""
    result = {"accepted": True, "reasons": [], "success": False, "duration_ms": None, "error": None}
    if config.DEFAULT_MODEL_BACKEND != "ollama" or not summary:
        return result
    prompt = (
        "Validate whether this resume summary is truthful and appropriately positioned.\n"
        f"Candidate evidence: {(candidate_context or '')[:3000]}\n"
        f"Requested keywords: {json.dumps(keywords)}\n"
        f"Summary: {summary}\n"
        "Classify each sentence as supported, too_broad, or unsupported using the candidate evidence. "
        "If any sentence is unsupported, accepted must be false. "
        "Reject the summary if it claims a domain, tool, platform, responsibility, or business context that is not supported by the candidate evidence. "
        "Reject unsupported domain/tool claims, obvious exaggeration, or junior filler tone. "
        "It is better to reject the summary than allow a polished unsupported claim. "
        "Do not reject just because not every keyword is used.\n"
        "Keep each reason under 18 words. "
        'Return only valid compact JSON: {"accepted": boolean, "reasons": ["..."]}'
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
        retry_prompt = (
            "Return compact valid JSON for this resume-summary validation. "
            "No prose, no markdown, no inner quotes in reason strings. "
            "Use at most 2 short reasons.\n"
            f"Candidate evidence: {(candidate_context or '')[:1800]}\n"
            f"Requested keywords: {json.dumps(keywords)}\n"
            f"Summary: {summary}\n"
            'Return only: {"accepted": false, "reasons": ["short reason"]} or {"accepted": true, "reasons": []}'
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
    result: dict[str, Any] = {"summary": "", "success": False, "error": None, "duration_ms": None}
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    if not candidate_context or not job_title:
        return result

    summary_keywords = _dedupe_case(keywords)[:3]
    kw_list = ", ".join(summary_keywords) if summary_keywords else ""
    kw_line = (
        f"Optional JD keywords, use at most 3 only if they fit: {kw_list}\n" if kw_list else ""
    )
    existing_line = (
        f"Existing resume summary for context: {existing_summary.strip()}\n"
        if existing_summary.strip()
        else ""
    )
    feedback_line = (
        f"Length adjustment needed: {line_feedback.strip()}\n" if line_feedback.strip() else ""
    )
    role_key = (role_family or "").strip().lower()
    if role_key == "pm":
        role_instruction = (
            "Use product-adjacent strengths: user experience, stakeholder communication, "
            "bug triage, feedback synthesis, structured problem solving, and delivery ownership. "
            "Do not use a generic software-only summary. "
        )
    elif role_key == "data":
        role_instruction = (
            "Use data/database positioning: database-backed systems, data reliability, "
            "automation, analytical work, and supported data tools. "
        )
    elif role_key == "infrastructure":
        role_instruction = (
            "Use infrastructure positioning: cloud or network systems, reliability, "
            "monitoring, security, automation, and supported platform tooling. "
        )
    elif job_level == "intern":
        role_instruction = (
            "Use intern/co-op positioning: learning velocity, collaboration, testing, "
            "Git/process habits, and delivery support. "
        )
    else:
        role_instruction = "Use a grounded software engineering tone focused on concrete delivery. "
    prompt = (
        f"Job title: {job_title}\n"
        f"{kw_line}"
        f"{existing_line}"
        f"{feedback_line}"
        f"Candidate background: {candidate_context}\n"
        f"Write a 2-3 sentence professional summary for this candidate targeting this job. "
        f"Aim for 4-5 printed resume lines. "
        f"No invented facts. Use only the background provided. "
        f"If the candidate background does not support a strong targeted summary, return an empty summary rather than filling space with generic or unsupported claims. "
        f"Start from true candidate facts, skills, and evidence before job-description wording. "
        f"Use at most 3 requested keywords, only when they fit the candidate background naturally. "
        f"Do not try to include every keyword. Prioritize accurate, supported technologies and role/process terms. "
        f"{role_instruction}"
        f"Do not use junior-sounding filler such as motivated, eager, passionate, aspiring, contribute immediately, or diverse programming skills. "
        f"Prefer concrete experience over enthusiasm. "
        f"Do not claim expertise in technologies not present in the candidate background. "
        f"Do not imply direct domain experience unless the candidate background supports it. "
        f"If an existing resume summary was provided, use it as context but rewrite it for this job rather than copying it verbatim.\n"
        f'Return only: {{"summary": "..."}}'
    )
    start = time.perf_counter()
    try:
        _llm_log("call 2/3: summary [sending]", prompt, "", None)
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        _llm_log("call 2/3: summary [done]", prompt, raw, result["duration_ms"])
        if logger:
            logger.llm_call("generate_summary", prompt, raw, result["duration_ms"], success=True)
        parsed = _extract_json_object(raw)
        text = (parsed.get("summary") or "").strip()
        if text:
            result["summary"] = text
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

    kw_list = ", ".join(keywords)
    preserve_line = ""
    if keywords_to_preserve:
        preserve_line = (
            f"Keywords already in this bullet that must stay: {', '.join(keywords_to_preserve)}.\n"
        )
    prompt = (
        f"Rewrite this resume bullet to naturally weave in these keywords where they fit: {kw_list}\n"
        f"{preserve_line}"
        f"Try these strategies in order. Stop after the first strategy that produces a truthful, natural rewrite:\n"
        f"1. REPLACE: If a keyword names the same type of technology, method, or concept as something already in the bullet, replace or substitute naturally.\n"
        f"2. REWORD: If replacement does not work, reword or restructure the bullet so the original work and the keyword appear together naturally. The keyword must fit the actual work described by the original bullet.\n"
        f"3. ADD SENTENCE: If one or more keywords still fit but cannot be included by replacement or rewording, add at most one new sentence anywhere in the bullet. The new sentence must be directly about the original work. Pack multiple remaining keywords into that one sentence only if they fit naturally.\n"
        f"4. STOP: Any remaining keywords that do not fit go in keywords_skipped. Do not force them.\n"
        f"Rules:\n"
        f"- Preserve all original facts, metrics, numbers, scope, and outcomes.\n"
        f"- Preserve the original bullet's order and Google XYZ-style structure when possible: outcome or metric first, then action, method, tool, or scope.\n"
        f"- Do not invent a new outcome, tool usage, product domain, customer domain, or responsibility.\n"
        f"- It is OK to use adjacent wording that is not explicit in the original if it stays in the same work context, same outcome, and coherent technology/workflow family.\n"
        f"- Do not combine technologies, vendors, resources, or workflows in a way that would sound incoherent or imply a different project.\n"
        f"- Do not explain what a technology does. Use technology and domain phrases as names.\n"
        f"- Do not claim a technology was used for an unrelated purpose or a different workflow than the original bullet.\n"
        f"- If a keyword is an action phrase, keep the action and object visibly together. For any keyword beginning with Monitor, write monitoring plus the rest of the keyword if truthful. For any keyword beginning with Automate, write automating plus the rest of the keyword if truthful. Otherwise put that keyword in keywords_skipped.\n"
        f"- Do not count scattered words as using an action keyword. Example: monitors in one clause plus data pipelines somewhere else does not count as Monitor data pipelines.\n"
        f"- Prefer additive related-tech phrasing when it is more truthful than replacement, for example React/Next.js.\n"
        f"- Do not create unnatural slash pairs or false pairings. Example: do not write LLM/React.\n"
        f"- Avoid lazy append phrases such as leveraging X unless X naturally explains the method or context of the original work.\n"
        f"- At most one new sentence total.\n"
        f"- Keep the rewritten bullet concise. It should usually be close to the original length and never more than 20 percent longer unless needed to preserve grammar.\n"
        f"Bullet: {bullet.strip()}\n"
        f'Return only: {{"bullet": "...", "keywords_used": [...], "keywords_skipped": [...]}}'
    )
    start = time.perf_counter()
    try:
        _llm_log(f"rewrite bullet [{kw_list[:40]}] [sending]", prompt, "", None)
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        _llm_log(f"rewrite bullet [{kw_list[:40]}] [done]", prompt, raw, result["duration_ms"])
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
            presence = validate_claimed_keywords_present(
                rewritten=text,
                requested_keywords=keywords,
                claimed_used=claimed_used,
            )
            result["claimed_keyword_presence"] = presence

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
            if not presence["accepted"] and validation.get("accepted"):
                result["presence_resolved_by_llm_validation"] = True
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
                    repair_presence = validate_claimed_keywords_present(
                        rewritten=repair_text,
                        requested_keywords=keywords,
                        claimed_used=repair_used,
                    )
                    result["repair_claimed_keyword_presence"] = repair_presence
                    if repair_presence["accepted"]:
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
                result["error"] = (
                    "claimed_keyword_missing"
                    if not presence["accepted"]
                    else "rewrite_validation_failed"
                )
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
                result["error"] = (
                    "claimed_keyword_missing"
                    if not presence["accepted"]
                    else "rewrite_validation_failed"
                )
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
        prompt = _build_user_prompt(title, description)
        if config.LOG_LLM_IO:
            limit = max(1, int(config.LOG_LLM_MAX_CHARS))
            meta["prompt_text"] = prompt[:limit]
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
        if isinstance(parsed.get("jd_usable"), bool):
            meta["jd_usable"] = parsed["jd_usable"]
        reason = parsed.get("jd_usable_reason")
        if isinstance(reason, str) and reason.strip():
            meta["jd_usable_reason"] = reason.strip()[:500]
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
                _build_user_prompt(title, description),
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
                _build_user_prompt(title, description),
                str(exc),
                meta["duration_ms"],
                success=False,
                error=meta["error"],
            )
        return classification, keywords, meta
