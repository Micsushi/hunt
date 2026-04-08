from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from typing import Any

from . import config


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
    desc_truncated = (description or "")[:1200]
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


def rewrite_summary(existing_summary: str, keywords: list[str]) -> dict[str, Any]:
    """Ask Ollama to rewrite the resume summary injecting the given keywords.

    Returns dict with keys:
      - "summary": rewritten summary string (or original on failure)
      - "success": bool
      - "error": str or None
      - "duration_ms": int or None
    """
    result: dict[str, Any] = {"summary": existing_summary, "success": False, "error": None, "duration_ms": None}
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    if not existing_summary or not keywords:
        return result

    kw_list = ", ".join(keywords[:5])
    prompt = (
        f"Rewrite this resume summary to naturally include these keywords: {kw_list}\n"
        f"Keep the same meaning, same length (2-3 sentences), no invented facts.\n"
        f"Summary: {existing_summary.strip()}\n"
        f'Return only: {{"summary": "..."}}'
    )
    try:
        start = time.perf_counter()
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        parsed = _extract_json_object(raw)
        text = parsed.get("summary", "").strip()
        if text:
            result["summary"] = text
            result["success"] = True
    except Exception as exc:
        result["error"] = str(exc) or exc.__class__.__name__
        if result["duration_ms"] is None:
            result["duration_ms"] = int((time.perf_counter() - start) * 1000) if "start" in dir() else None
    return result


def rewrite_bullets(bullets: list[str], keywords: list[str]) -> dict[str, Any]:
    """Ask Ollama to reformulate selected bullets to use JD keyword vocabulary.

    Sends all bullets in one call. Returns dict with keys:
      - "bullets": list of rewritten bullet strings (falls back to originals on failure)
      - "success": bool
      - "error": str or None
      - "duration_ms": int or None
    """
    result: dict[str, Any] = {"bullets": list(bullets), "success": False, "error": None, "duration_ms": None}
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return result
    if not bullets or not keywords:
        return result

    kw_list = ", ".join(keywords[:5])
    numbered = "\n".join(f"{i + 1}. {b.strip()}" for i, b in enumerate(bullets))
    prompt = (
        f"Rewrite these resume bullets to naturally use these keywords where they fit: {kw_list}\n"
        f"Rules: same meaning, same metrics, no invented facts, keep each bullet one sentence.\n"
        f"Bullets:\n{numbered}\n"
        f'Return only: {{"bullets": ["bullet 1 text", "bullet 2 text", ...]}}'
    )
    try:
        start = time.perf_counter()
        raw = _ollama_chat(prompt)
        result["duration_ms"] = int((time.perf_counter() - start) * 1000)
        parsed = _extract_json_object(raw)
        rewritten = parsed.get("bullets")
        if isinstance(rewritten, list) and len(rewritten) == len(bullets):
            cleaned = [str(b).strip() for b in rewritten if str(b).strip()]
            if len(cleaned) == len(bullets):
                result["bullets"] = cleaned
                result["success"] = True
    except Exception as exc:
        result["error"] = str(exc) or exc.__class__.__name__
        if result["duration_ms"] is None:
            result["duration_ms"] = int((time.perf_counter() - start) * 1000) if "start" in dir() else None
    return result


def distribute_keywords(
    keywords: list[str],
    selected_bullets: list[str],
    *,
    max_total: int = 10,
) -> dict[str, list[str]]:
    """Split keywords into two buckets: bullet_keywords and summary_keywords.

    Strategy:
    - Score each keyword against the combined bullet text.
    - Keywords that appear or have strong overlap with existing bullets
      go to bullet_keywords (the LLM will work them in during reformulation).
    - The rest go to summary_keywords (injected during summary rewrite).
    - Total across both buckets is capped at max_total.
    """
    if not keywords:
        return {"bullet_keywords": [], "summary_keywords": []}

    bullets_text = " ".join(selected_bullets).lower()

    bullet_kws: list[str] = []
    summary_kws: list[str] = []

    for kw in keywords:
        kw_lower = kw.lower()
        # Check if keyword or any word from keyword appears in bullet text.
        tokens = [t for t in re.split(r"[\s/+#.-]+", kw_lower) if len(t) > 2]
        hits = sum(1 for t in tokens if t in bullets_text) if tokens else 0
        if hits > 0 or kw_lower in bullets_text:
            bullet_kws.append(kw)
        else:
            summary_kws.append(kw)

    # Cap combined to max_total, split evenly but favour bullets.
    bullet_cap = max_total // 2 + max_total % 2
    summary_cap = max_total // 2
    return {
        "bullet_keywords": bullet_kws[:bullet_cap],
        "summary_keywords": summary_kws[:summary_cap],
    }


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
        start = time.perf_counter()
        content = _ollama_chat(prompt)
        meta["duration_ms"] = int((time.perf_counter() - start) * 1000)
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
