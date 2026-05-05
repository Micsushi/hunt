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

RELATED_VISIBLE_PHRASES = {
    "react": ("react", "react/next.js", "next.js/react"),
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
    """Return true when a requested keyword is visibly represented in text.

    This intentionally accepts close grammatical variants for action phrases,
    but it still requires the action and object to appear together. For example,
    `Monitor data pipelines` can match `monitoring data pipelines`; scattered
    words like `monitors` and `data pipelines` in different clauses do not count.
    """
    key = _normalize_visible_text(keyword)
    visible = _normalize_visible_text(text)
    if not key or not visible:
        return False
    allowed = list(RELATED_VISIBLE_PHRASES.get(key, (key,)))
    allowed.extend(_visible_action_phrases(key))
    return any(_normalize_visible_text(phrase) in visible for phrase in allowed)


def validate_claimed_keywords_present(
    *,
    rewritten: str,
    requested_keywords: list[str],
    claimed_used: list[str],
) -> dict[str, Any]:
    """Reject model metadata when claimed used keywords do not visibly appear.

    This is intentionally mechanical: if the model says it used React, the text
    must contain React or a pre-approved visible related-tech phrase like
    React/Next.js. If metadata is inconsistent, the caller should keep the
    original bullet and treat all requested keywords as unused.
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
        "Validate whether a rewritten resume bullet is fully supported by the original bullet.\n"
        f"Original bullet: {original}\n"
        f"Rewritten bullet: {rewritten}\n"
        f"Requested keywords: {', '.join(requested_keywords)}\n"
        "Judge each requested keyword independently. A rewritten bullet may be partially "
        "supported: put supported keywords in keywords_supported and unsupported keywords "
        "in keywords_rejected.\n"
        "Accept reasonable generalizations only when the original supports them. Examples: "
        "Vercel or Supabase can support cloud infrastructure phrasing; Next.js can support "
        "React/Next.js phrasing; brainwave scoring or model accuracy can support machine "
        "learning phrasing; Bitbucket Pipelines, ECR, Kubernetes, deployments, or CI/CD "
        "can support Azure DevOps-style CI/CD workflow phrasing, but not unsupported direct "
        "Azure cloud resource claims. Data-domain terms such as data pipelines, data exploration, "
        "model training, ModelOps, Productionalize, and Operationalize require direct "
        "evidence in the original bullet. Do not infer them from generic full-stack "
        "architecture. Datadog metrics, monitors, logging, and alerts can support "
        "monitoring data pipelines or services only when the rewrite explicitly keeps the "
        "monitoring action and monitored object together. Inflected action phrases are OK, "
        "such as automating data pipelines for Automate data pipelines. Infrastructure as Code requires direct evidence such as "
        "Terraform, CDK, Pulumi, CloudFormation, IaC, or infrastructure-as-code. "
        "Security domain terms such as real-time threat intelligence, XDR, MDR, ITDR, "
        "and SIEM require direct domain evidence.\n"
        "Reject unsupported technology usage, unsupported domain experience, or vague "
        "claims not implied by the original. Do not reject a whole rewrite only because "
        "one keyword is unsupported if another keyword is clearly supported.\n"
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


def validate_summary_grounding(
    summary: str,
    candidate_context: str,
    keywords: list[str],
) -> dict[str, Any]:
    """Reject summaries with junior filler or unsupported direct domain claims."""
    summary_l = (summary or "").lower()
    context_l = (candidate_context or "").lower()
    reasons: list[str] = []
    for phrase in SUMMARY_BANNED_TONE:
        if phrase in summary_l:
            reasons.append(f"banned_tone:{phrase}")
    keywords_to_check = _dedupe_case(list(keywords) + list(DOMAIN_KEYWORDS))
    for keyword in keywords_to_check:
        key = (keyword or "").strip().lower()
        if (
            key
            and keyword_requires_direct_support(keyword)
            and key in summary_l
            and key not in context_l
        ):
            reasons.append(f"unsupported_summary_domain:{keyword}")
    return {"accepted": not reasons, "reasons": reasons}


def _ollama_chat(user_prompt: str) -> str:
    host = config.OLLAMA_HOST
    model = config.OLLAMA_MODEL_NAME
    timeout = config.OLLAMA_TIMEOUT_SEC
    payload = {
        "model": model,
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.2},
        "messages": [
            {
                "role": "system",
                "content": (
                    "You read job postings for resume tailoring. "
                    "Respond with one JSON object only, no markdown, no commentary."
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


def _build_user_prompt(title: str, description: str) -> str:
    desc_truncated = (description or "")[:4000]
    return f"""Job title: {title}
Job description:
{desc_truncated or "(empty)"}

Answer two questions using only the title and description above.

1) Is this posting usable for tailoring a resume? Usable means there is enough concrete content (not just "apply on company site", not empty, not a useless stub). Scrapes that lost the real JD should be marked not usable.

2) List up to 20 resume-relevant signals that **appear verbatim** in the title or description (same spelling; minor case differences ok). Prefer technologies, tools, platforms, programming languages, frameworks, data tools, concrete engineering/process terms, and candidate qualities like leadership, ownership, collaboration, testing rigor, analytical thinking, or user empathy. Do not invent anything not in the text. Skip company boilerplate, compensation, executive visibility, hiring logistics, generic org labels, and language nice-to-haves unless they are central requirements. Do not include job titles merely to insert them into bullets. If the posting is not usable, return an empty keyword list.

Return a single JSON object with exactly these keys:
- "jd_usable": boolean
- "jd_usable_reason": string (one short sentence)
- "keywords": array of 0 to 20 strings

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
        if len(terms) >= 20:
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

    kw_list = ", ".join(keywords[:10]) if keywords else ""
    kw_line = f"Keywords to include naturally: {kw_list}\n" if kw_list else ""
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
        f"Use the keywords only when they fit the candidate background naturally. "
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
        f"- Do not invent a new outcome, tool usage, product domain, customer domain, or responsibility.\n"
        f"- Do not explain what a technology does. Use technology and domain phrases as names.\n"
        f"- Do not claim a technology was used for a purpose unless the original bullet supports that purpose.\n"
        f"- Data-domain terms such as data pipelines, data exploration, model training, ModelOps, Productionalize, and Operationalize require direct evidence in the original bullet. Do not infer them from generic full-stack architecture.\n"
        f"- If a keyword is an action phrase, keep the action and object visibly together. For any keyword beginning with Monitor, write monitoring plus the rest of the keyword if truthful. For any keyword beginning with Automate, write automating plus the rest of the keyword if truthful. Otherwise put that keyword in keywords_skipped.\n"
        f"- Do not count scattered words as using an action keyword. Example: monitors in one clause plus data pipelines somewhere else does not count as Monitor data pipelines.\n"
        f"- Datadog metrics, monitors, logging, and alerts may support monitoring data pipelines or services only when the rewritten bullet explicitly says what was monitored.\n"
        f"- Prefer additive related-tech phrasing when it is more truthful than replacement, for example React/Next.js.\n"
        f"- Do not create unnatural slash pairs or false pairings. Example: do not write LLM/React.\n"
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
        text = repair_rewrite_redundancy((parsed.get("bullet") or "").strip())
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
            presence = validate_claimed_keywords_present(
                rewritten=text,
                requested_keywords=keywords,
                claimed_used=claimed_used,
            )
            result["claimed_keyword_presence"] = presence
            if not presence["accepted"]:
                result["bullet"] = bullet
                result["success"] = False
                result["error"] = "claimed_keyword_missing"
                result["presence_supported_keywords"] = list(presence.get("present") or [])
                result["keywords_used"] = []
                result["keywords_skipped"] = list(keywords)
                return result

            validation = validate_rewrite_grounding(
                original=bullet,
                rewritten=text,
                requested_keywords=keywords,
            )
            if validation["accepted"]:
                try:
                    llm_validation = validate_rewrite_with_ollama(
                        original=bullet,
                        rewritten=text,
                        requested_keywords=keywords,
                        logger=logger,
                    )
                    validation = {
                        **validation,
                        "llm_validation": llm_validation,
                    }
                    if not llm_validation["accepted"]:
                        validation["accepted"] = False
                        validation["keywords_rejected"] = llm_validation[
                            "keywords_rejected"
                        ] or list(keywords)
                        validation["keywords_supported"] = llm_validation["keywords_supported"]
                except Exception as exc:
                    validation = {
                        **validation,
                        "accepted": False,
                        "keywords_supported": [],
                        "keywords_rejected": list(keywords),
                        "llm_validation_error": str(exc) or exc.__class__.__name__,
                    }
            result["validation"] = validation
            if not validation["accepted"]:
                used, skipped = _derive_keyword_outcome(
                    keywords,
                    validation.get("keywords_supported") or [],
                    validation.get("keywords_rejected") or [],
                )
                result["bullet"] = bullet
                result["success"] = False
                result["error"] = "rewrite_validation_failed"
                result["keywords_used"] = used
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
