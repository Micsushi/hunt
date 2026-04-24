from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import Any

from .. import config

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

2) List up to 20 keywords: technologies, tools, platforms, languages, cloud vendors, data tools, or clear domain phrases that **appear verbatim** in the title or description (same spelling; minor case differences ok). Do not invent anything not in the text. Skip generic filler ("team", "experience", "communication skills"). If the posting is not usable, return an empty keyword list.

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
) -> dict[str, Any]:
    """Ask Ollama to generate a professional summary paragraph for this candidate + job.

    candidate_context: brief string built from experience titles/companies + top skills.
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

    kw_list = ", ".join(keywords[:5]) if keywords else ""
    kw_line = f"Keywords to include naturally: {kw_list}\n" if kw_list else ""
    prompt = (
        f"Job title: {job_title}\n"
        f"{kw_line}"
        f"Candidate background: {candidate_context}\n"
        f"Write a 2-3 sentence professional summary for this candidate targeting this job. "
        f"No invented facts. Use only the background provided.\n"
        f'Return only: {{"summary": "..."}}'
    )
    start = time.perf_counter()
    try:
        _llm_log("call 2/3: summary [sending]", prompt, "", None)
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        _llm_log("call 2/3: summary [done]", prompt, raw, result["duration_ms"])
        parsed = _extract_json_object(raw)
        text = (parsed.get("summary") or "").strip()
        if text:
            result["summary"] = text
            result["success"] = True
    except Exception as exc:
        result["error"] = str(exc) or exc.__class__.__name__
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        _llm_log("call 2/3: summary [ERROR]", prompt, str(exc), result["duration_ms"])
    return result



def rewrite_bullet_targeted(bullet: str, keywords: list[str]) -> dict[str, Any]:
    """Rewrite a single resume bullet to naturally include specific keywords.

    Only modifies vocabulary where the keywords genuinely fit - same facts, same metrics.

    Returns dict with keys:
      - bullet: rewritten bullet string (falls back to original on failure)
      - success: bool
      - error: str or None
      - duration_ms: int or None
    """
    result: dict[str, Any] = {"bullet": bullet, "success": False, "error": None, "duration_ms": None}
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    if not bullet or not keywords:
        return result

    kw_list = ", ".join(keywords)
    prompt = (
        f"Rewrite this resume bullet to naturally include these keywords where they genuinely fit: {kw_list}\n"
        f"Rules: same facts, same metrics, no invented content, minimal changes, one sentence.\n"
        f"If the keywords do not fit naturally, return the bullet unchanged.\n"
        f"Bullet: {bullet.strip()}\n"
        f'Return only: {{"bullet": "..."}}'
    )
    start = time.perf_counter()
    try:
        _llm_log(f"rewrite bullet [{kw_list[:40]}] [sending]", prompt, "", None)
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        _llm_log(f"rewrite bullet [{kw_list[:40]}] [done]", prompt, raw, result["duration_ms"])
        parsed = _extract_json_object(raw)
        text = (parsed.get("bullet") or "").strip()
        if text:
            result["bullet"] = text
            result["success"] = True
    except Exception as exc:
        result["error"] = str(exc) or exc.__class__.__name__
        result["duration_ms"] = int((time.perf_counter() - start) * 1000) if "start" in locals() else None
        _llm_log("rewrite bullet [ERROR]", prompt, str(exc), result["duration_ms"])
    return result


def enrich_with_ollama_if_enabled(
    *,
    title: str,
    description: str,
    classification: dict,
    keywords: dict,
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
        return classification, keywords, meta
    except (json.JSONDecodeError, ValueError, TypeError, KeyError) as exc:
        if meta.get("duration_ms") is None:
            meta["duration_ms"] = (
                int((time.perf_counter() - start) * 1000) if "start" in locals() else None
            )
        meta["error"] = str(exc) or exc.__class__.__name__
        return classification, keywords, meta
