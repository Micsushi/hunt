from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import Any

from . import config

ALLOWED_FAMILIES = frozenset({"software", "pm", "data", "general", "unknown"})
ALLOWED_LEVELS = frozenset(
    {
        "intern",
        "new_grad",
        "junior",
        "mid",
        "senior",
        "staff",
        "principal",
        "manager",
        "director",
        "unknown",
    }
)
ALLOWED_BASE = frozenset({"software", "pm", "data", "general", "original"})
ALLOWED_CONCERN = frozenset(
    {
        "weak_description",
        "low_confidence_match",
        "page_limit_failed",
        "insufficient_source_facts",
        "manual_review_recommended",
    }
)


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


def _ollama_chat(user_prompt: str) -> str:
    host = config.OLLAMA_HOST
    model = config.OLLAMA_MODEL_NAME
    timeout = config.OLLAMA_TIMEOUT_SEC
    payload = {
        "model": model,
        # Ask Ollama to return strict JSON (reduces parse failures).
        "format": "json",
        "stream": False,
        "options": {"temperature": 0.2},
        "messages": [
            {
                "role": "system",
                "content": (
                    "You assist with job posting analysis for resume tailoring. "
                    "Respond with a single JSON object only, no markdown, no commentary."
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


def _clamp_str(value: Any, allowed: frozenset[str], default: str) -> str:
    if not isinstance(value, str):
        return default
    v = value.strip().lower()
    return v if v in allowed else default


def _normalize_classification(raw: dict[str, Any] | None, base: dict) -> dict:
    if not raw or not isinstance(raw, dict):
        return dict(base)
    out = dict(base)
    out["role_family"] = _clamp_str(
        raw.get("role_family"), ALLOWED_FAMILIES, base["role_family"]
    )
    out["job_level"] = _clamp_str(raw.get("job_level"), ALLOWED_LEVELS, base["job_level"])
    conf = raw.get("confidence")
    if isinstance(conf, (int, float)):
        out["confidence"] = max(0.0, min(0.95, float(conf)))
    if isinstance(raw.get("weak_description"), bool):
        out["weak_description"] = raw["weak_description"]
    out["recommended_base_resume"] = _clamp_str(
        raw.get("recommended_base_resume"),
        ALLOWED_BASE,
        base["recommended_base_resume"],
    )
    reasons = raw.get("reasons")
    if isinstance(reasons, list) and all(isinstance(x, str) for x in reasons):
        out["reasons"] = reasons[:24]
    flags = raw.get("concern_flags")
    if isinstance(flags, list):
        merged = [f for f in flags if isinstance(f, str) and f in ALLOWED_CONCERN]
        out["concern_flags"] = list(dict.fromkeys(merged + base.get("concern_flags", [])))
    return out


def _normalize_keywords(raw: dict[str, Any] | None, base: dict) -> dict:
    if not raw or not isinstance(raw, dict):
        return dict(base)
    out = dict(base)
    for key in (
        "must_have_terms",
        "nice_to_have_terms",
        "responsibilities",
        "tools_and_technologies",
        "domain_terms",
        "seniority_signals",
    ):
        val = raw.get(key)
        if isinstance(val, list) and all(isinstance(x, str) for x in val):
            cap = 16 if key == "responsibilities" else 24
            out[key] = val[:cap]
    flags = raw.get("concern_flags")
    if isinstance(flags, list):
        merged = [f for f in flags if isinstance(f, str) and f in ALLOWED_CONCERN]
        out["concern_flags"] = list(dict.fromkeys(merged + base.get("concern_flags", [])))
    return out


def _build_user_prompt(title: str, description: str, base_c: dict, base_k: dict) -> str:
    return f"""Job title: {title}
Job description:
{description or "(empty)"}

Heuristic baseline (JSON) — refine if needed, stay consistent with the posting:
classification: {json.dumps(base_c)}
keywords: {json.dumps(base_k)}

Return one JSON object with exactly two keys, "classification" and "keywords".

"classification" must match this shape:
- role_family: one of software, pm, data, general, unknown
- job_level: one of intern, new_grad, junior, mid, senior, staff, principal, manager, director, unknown
- confidence: number 0..1
- weak_description: boolean (true if the description is too sparse to tailor well, e.g. under ~120 chars of substance)
- recommended_base_resume: one of software, pm, data, general, original (use original only if family is unclear)
- reasons: array of short strings explaining signals
- concern_flags: subset of weak_description, low_confidence_match, insufficient_source_facts, manual_review_recommended

"keywords" must match this shape:
- must_have_terms: up to 12 short tokens or phrases strongly tied to the role
- nice_to_have_terms: up to 12 secondary terms
- responsibilities: up to 6 short paraphrased responsibility lines from the JD (empty if JD too thin)
- tools_and_technologies: up to 12 tools/languages/platforms explicitly mentioned
- domain_terms: up to 8 domain phrases
- seniority_signals: array of strings (may repeat job_level)
- concern_flags: same flag vocabulary as classification (may overlap)"""


def enrich_with_ollama_if_enabled(
    *,
    title: str,
    description: str,
    classification: dict,
    keywords: dict,
) -> tuple[dict, dict, dict]:
    """When model backend is ollama, ask the local model to refine classification + keywords.

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
        prompt = _build_user_prompt(title, description, classification, keywords)
        start = time.perf_counter()
        content = _ollama_chat(prompt)
        meta["duration_ms"] = int((time.perf_counter() - start) * 1000)
        if config.LOG_LLM_IO:
            limit = max(1, int(config.LOG_LLM_MAX_CHARS))
            meta["prompt_text"] = prompt[:limit]
            meta["response_text"] = (content or "")[:limit]
        parsed = _extract_json_object(content)
        cls_raw = parsed.get("classification")
        kw_raw = parsed.get("keywords")
        if not isinstance(cls_raw, dict) or not isinstance(kw_raw, dict):
            raise ValueError("missing classification or keywords object")
        new_c = _normalize_classification(cls_raw, classification)
        new_k = _normalize_keywords(kw_raw, keywords)
        meta["ollama_enriched"] = True
        return new_c, new_k, meta
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
        meta["error"] = str(exc)
        return classification, keywords, meta
    except (json.JSONDecodeError, ValueError, TypeError, KeyError) as exc:
        meta["error"] = str(exc)
        return classification, keywords, meta
