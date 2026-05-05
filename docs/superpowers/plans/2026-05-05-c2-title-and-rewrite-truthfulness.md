# C2 Title and Rewrite Truthfulness Implementation Plan
> REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans.

Goal: Make C2 ad-hoc resume tailoring infer the correct job title/level and reject bullet rewrites that introduce unsupported claims.

Architecture: Add a small JD metadata layer for title inference and level-safe classification, then add a rewrite validation layer after LLM bullet rewrites. Keep the existing RAG/drop pipeline intact: unsupported high-tier keywords should move to the summary pool instead of being forced into bullets.

Tech Stack: Python, FastAPI, pytest, Ollama JSON chat, existing Fletcher `PipelineLogger`.

## Problem Statement

The Sophos JD run exposed four quality failures:

- The ad-hoc endpoint used the first pasted line as the title, producing `About Us` instead of `Software Engineer`.
- The classifier returned `job_level=intern` because it matched an incidental phrase about mentoring interns.
- The rewrite model forced domain terms into unsupported bullets, especially `real-time threat intelligence` on a Datadog observability bullet and `AI-driven platform` on a Next.js feedback bullet.
- Related keyword insertion created weak or redundant phrasing like `Kotlin microservices and backend services` and stretch claims like `Infrastructure as Code` on Vercel/Supabase.

## Target Behavior

- Option A/Hunter jobs use the structured DB title and company directly.
- Option B/ad-hoc infers a clean title from pasted JD text when no separate title is provided.
- Section headings such as `About Us`, `Role Summary`, `What You Will Do`, and `Ready to Join Us` are never treated as job titles.
- Sophos JD title resolves to `Software Engineer` or `Software Engineer, Security Features`.
- Sophos JD level resolves to `mid` or `junior_mid`, never `intern`.
- Unsupported rewrites are rejected. Original bullet stays unchanged and rejected keywords move to the summary pool.
- Domain/security phrases require direct support in the original bullet. Tech/framework phrases may use semantically natural related-tech phrasing.

## Files

Create:
- `fletcher/jobs/title_inference.py`
- `tests/test_title_inference.py`
- `tests/test_rewrite_validation.py`

Modify:
- `backend/app.py`
- `fletcher/ad_hoc_pipeline.py`
- `fletcher/jobs/classifier.py`
- `fletcher/llm/llm_enrich.py`
- `tests/test_ad_hoc_pipeline.py`
- `tests/test_component2_stage1.py`
- `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/ad-hoc-pipeline-v2-plan.md`
- `C:/Users/sushi/Documents/agentsvault/log.md`

## Task 1: Add Deterministic JD Title Inference

Files: Create `fletcher/jobs/title_inference.py`, create `tests/test_title_inference.py`.

- [ ] Step 1: Write tests.

```python
from fletcher.jobs.title_inference import infer_title_from_description, normalize_title_candidate


def test_rejects_section_heading_about_us():
    assert normalize_title_candidate("**About Us**") == ""


def test_infers_seeking_title_from_sophos_jd():
    jd = """
    **About Us**
    Sophos is a cybersecurity leader.
    ### **Role Summary**
    We are seeking a Software Engineer to join our Security features team and help build systems.
    """
    assert infer_title_from_description(jd) == "Software Engineer"


def test_prefers_explicit_title_line():
    jd = "Job Title: Software Engineer, Security Features\nAbout Us\nSophos..."
    assert infer_title_from_description(jd) == "Software Engineer, Security Features"


def test_empty_when_no_signal():
    assert infer_title_from_description("About Us\nReady to Join Us?") == ""
```

- [ ] Step 2: Run test and expect fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_title_inference.py -q
```

- [ ] Step 3: Implement `fletcher/jobs/title_inference.py`.

```python
from __future__ import annotations

import re

SECTION_HEADINGS = {
    "about us",
    "role summary",
    "what you will do",
    "what you will bring",
    "desirable",
    "ready to join us?",
    "what's great about sophos?",
    "our commitment to you",
    "data protection",
}


def _clean_heading(text: str) -> str:
    value = re.sub(r"[*#_`]+", "", text or "")
    value = re.sub(r"\s+", " ", value).strip(" :-")
    return value.strip()


def normalize_title_candidate(text: str) -> str:
    candidate = _clean_heading(text)
    if not candidate:
        return ""
    if candidate.lower() in SECTION_HEADINGS:
        return ""
    if len(candidate.split()) > 8:
        return ""
    return candidate


def infer_title_from_description(description: str) -> str:
    text = description or ""
    explicit_patterns = [
        r"(?im)^\s*(?:job\s*)?title\s*[:\-]\s*(.+)$",
        r"(?im)^\s*position\s*[:\-]\s*(.+)$",
        r"(?im)^\s*role\s*[:\-]\s*(.+)$",
    ]
    for pattern in explicit_patterns:
        match = re.search(pattern, text)
        if match:
            candidate = normalize_title_candidate(match.group(1))
            if candidate:
                return candidate

    prose_patterns = [
        r"(?i)\bseeking\s+(?:an?\s+)?([A-Z][A-Za-z0-9+/# .,&-]{2,80}?)\s+to\s+join\b",
        r"(?i)\bjoin\s+.*?\s+as\s+(?:an?\s+)?([A-Z][A-Za-z0-9+/# .,&-]{2,80}?)(?:\.|,|\n)",
        r"(?i)\bthis position is for\s+(?:an?\s+)?([A-Z][A-Za-z0-9+/# .,&-]{2,80}?)(?:\.|,|\n)",
    ]
    for pattern in prose_patterns:
        match = re.search(pattern, text)
        if match:
            candidate = normalize_title_candidate(match.group(1))
            if candidate:
                return candidate

    for line in text.splitlines()[:12]:
        candidate = normalize_title_candidate(line)
        if candidate and any(term in candidate.lower() for term in ("engineer", "developer", "analyst", "manager")):
            return candidate
    return ""
```

- [ ] Step 4: Run test and expect pass.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_title_inference.py -q
```

- [ ] Step 5: Commit.

```powershell
git add fletcher/jobs/title_inference.py tests/test_title_inference.py
git commit -m "Infer ad-hoc job titles"
```

## Task 2: Use Inferred Title in Ad-Hoc Endpoint and Pipeline

Files: Modify `backend/app.py`, `fletcher/ad_hoc_pipeline.py`, `tests/test_ad_hoc_pipeline.py`.

- [ ] Step 1: Write/update tests.

Add to `tests/test_ad_hoc_pipeline.py`:

```python
def test_pipeline_uses_inferred_title_when_title_is_heading(base_mocks, monkeypatch):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline
    import fletcher.ad_hoc_pipeline as mod

    monkeypatch.setattr(mod, "infer_title_from_description", lambda _description: "Software Engineer")

    run_ad_hoc_pipeline(title="**About Us**", description="We are seeking a Software Engineer to join.")

    assert base_mocks.classify_job.call_args.kwargs["title"] == "Software Engineer"
    assert base_mocks.extract_keywords.call_args.kwargs["title"] == "Software Engineer"
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_pipeline.py -q
```

- [ ] Step 3: Implement title normalization in pipeline.

In `fletcher/ad_hoc_pipeline.py` import:

```python
from .jobs.title_inference import infer_title_from_description, normalize_title_candidate
```

Add helper:

```python
def _resolve_job_title(title: str, description: str) -> str:
    normalized = normalize_title_candidate(title)
    if normalized:
        return normalized
    inferred = infer_title_from_description(description)
    return inferred or title or ""
```

Near start of `run_ad_hoc_pipeline()`:

```python
    resolved_title = _resolve_job_title(title, description)
```

Use `resolved_title` for:
- config log title
- `classify_job`
- `extract_keywords`
- `enrich_with_ollama_if_enabled`
- summary `job_title`
- ad-hoc label fallback
- `_run_iteration(title=...)`

Keep the original pasted `title` in logs as `input_title`.

In `backend/app.py`, replace first-line extraction:

```python
        from fletcher.jobs.title_inference import infer_title_from_description
        _title = infer_title_from_description(job_details)
```

This endpoint can pass an empty title if inference fails because the pipeline also resolves it.

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_ad_hoc_pipeline.py tests/test_title_inference.py -q
```

- [ ] Step 5: Commit.

```powershell
git add backend/app.py fletcher/ad_hoc_pipeline.py tests/test_ad_hoc_pipeline.py
git commit -m "Use inferred ad-hoc job title"
```

## Task 3: Fix Job Level Classification

Files: Modify `fletcher/jobs/classifier.py`, create/update tests in `tests/test_title_inference.py` or `tests/test_component2_stage1.py`.

- [ ] Step 1: Write tests.

Add to a classifier test file:

```python
from fletcher.jobs.classifier import classify_job


def test_mentor_interns_does_not_make_role_intern():
    result = classify_job(
        title="Software Engineer",
        description="This position is for an engineer with a few years of professional experience. You will mentor IC1 engineers and interns.",
    )
    assert result["job_level"] in {"mid", "junior_mid"}


def test_actual_intern_title_still_intern():
    result = classify_job(title="Software Developer Intern", description="Summer internship role.")
    assert result["job_level"] == "intern"
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_component2_stage1.py -q
```

- [ ] Step 3: Implement title-first and context-aware level detection.

In `fletcher/jobs/classifier.py`:

```python
def _detect_level(title: str, description: str) -> tuple[str, list[str]]:
    title_text = (title or "").lower()
    desc_text = (description or "").lower()
    reasons: list[str] = []

    if any(p in title_text for p in LEVEL_PATTERNS["intern"]):
        return "intern", ["level=intern:title"]
    if any(p in title_text for p in LEVEL_PATTERNS["senior"]):
        return "senior", ["level=senior:title"]
    if any(p in title_text for p in LEVEL_PATTERNS["junior"]):
        return "junior", ["level=junior:title"]

    if re.search(r"\b(?:few|2|3|4)\+?\s+years?\s+of\s+professional", desc_text):
        return "mid", ["level=mid:years_professional"]
    if "moderate guidance" in desc_text or "own delivery" in desc_text:
        return "mid", ["level=mid:ownership_signal"]
    if re.search(r"\b(?:internship|co-op|coop)\b", desc_text):
        return "intern", ["level=intern:description"]

    for level, patterns in LEVEL_PATTERNS.items():
        if level == "intern":
            continue
        if any(pattern in desc_text for pattern in patterns):
            return level, [f"level={level}:description"]
    return "unknown", []
```

Use `_detect_level()` inside `classify_job()` instead of scanning all level patterns in order.

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_component2_stage1.py -q
```

- [ ] Step 5: Commit.

```powershell
git add fletcher/jobs/classifier.py tests/test_component2_stage1.py
git commit -m "Fix job level classification"
```

## Task 4: Add Keyword Category Guardrails

Files: Modify `fletcher/llm/llm_enrich.py`, create `tests/test_rewrite_validation.py`.

- [ ] Step 1: Write tests.

```python
from fletcher.llm.llm_enrich import categorize_keyword, keyword_requires_direct_support


def test_security_domain_terms_require_direct_support():
    for keyword in ["real-time threat intelligence", "SIEM", "XDR", "ITDR", "MDR", "AI-driven platform"]:
        assert categorize_keyword(keyword) == "domain"
        assert keyword_requires_direct_support(keyword)


def test_common_tech_terms_do_not_require_direct_support():
    for keyword in ["React", "backend services", "API", "Terraform"]:
        assert categorize_keyword(keyword) == "tech"
        assert not keyword_requires_direct_support(keyword)
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py -q
```

- [ ] Step 3: Implement helpers in `fletcher/llm/llm_enrich.py`.

```python
DOMAIN_KEYWORDS = {
    "real-time threat intelligence",
    "threat intelligence",
    "siem",
    "xdr",
    "itdr",
    "mdr",
    "ai-driven platform",
}


def categorize_keyword(keyword: str) -> str:
    value = (keyword or "").strip().lower()
    if value in DOMAIN_KEYWORDS:
        return "domain"
    return "tech"


def keyword_requires_direct_support(keyword: str) -> bool:
    return categorize_keyword(keyword) == "domain"
```

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py -q
```

- [ ] Step 5: Commit.

```powershell
git add fletcher/llm/llm_enrich.py tests/test_rewrite_validation.py
git commit -m "Classify strict rewrite keywords"
```

## Task 5: Add Rewrite Validator

Files: Modify `fletcher/llm/llm_enrich.py`, `fletcher/ad_hoc_pipeline.py`, `tests/test_rewrite_validation.py`, `tests/test_ad_hoc_pipeline.py`.

- [ ] Step 1: Write validator tests.

```python
from fletcher.llm.llm_enrich import validate_rewrite_grounding


def test_rejects_datadog_threat_intelligence_claim():
    result = validate_rewrite_grounding(
        original="Optimized bug detection speed by configuring Datadog metrics, monitors and centralized logging with automated alerting and error traces.",
        rewritten="Optimized bug detection speed by configuring Datadog metrics, monitors, and centralized logging, integrating real-time threat intelligence with automated alerting and error traces.",
        requested_keywords=["real-time threat intelligence"],
    )
    assert result["accepted"] is False
    assert result["keywords_rejected"] == ["real-time threat intelligence"]


def test_rejects_ai_platform_feedback_claim():
    result = validate_rewrite_grounding(
        original="Enhanced user engagement by building a responsive UI using Next.js and Framer Motion based on beta tester feedback.",
        rewritten="Enhanced user engagement by building a responsive UI using Next.js and Framer Motion, leveraging an AI-driven platform for iterative improvements.",
        requested_keywords=["AI-driven platform"],
    )
    assert result["accepted"] is False
    assert result["keywords_rejected"] == ["AI-driven platform"]


def test_accepts_machine_learning_brainwave_processing():
    result = validate_rewrite_grounding(
        original="Achieved 85% accuracy in attention scoring by developing a Python backend for real-time brainwave processing and data optimization.",
        rewritten="Achieved 85% accuracy in attention scoring by developing a Python backend for real-time brainwave processing and data optimization using machine learning techniques.",
        requested_keywords=["machine learning"],
    )
    assert result["accepted"] is True
    assert result["keywords_supported"] == ["machine learning"]


def test_flags_redundant_backend_services_phrase():
    result = validate_rewrite_grounding(
        original="Enhanced real-time subscriber targeting accuracy by developing Kotlin microservices that integrated platforms via RESTful APIs.",
        rewritten="Enhanced real-time subscriber targeting accuracy by developing Kotlin microservices and backend services that integrated platforms via RESTful APIs.",
        requested_keywords=["backend services"],
    )
    assert result["accepted"] is False
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py -q
```

- [ ] Step 3: Implement deterministic validator first.

In `fletcher/llm/llm_enrich.py`:

```python
def validate_rewrite_grounding(
    *,
    original: str,
    rewritten: str,
    requested_keywords: list[str],
) -> dict[str, Any]:
    original_l = original.lower()
    rewritten_l = rewritten.lower()
    rejected: list[str] = []
    supported: list[str] = []
    reasons: list[str] = []

    if "microservices and backend services" in rewritten_l:
        rejected.extend([kw for kw in requested_keywords if kw.lower() == "backend services"])
        reasons.append("redundant_backend_services")

    for keyword in requested_keywords:
        key = keyword.lower()
        if keyword_requires_direct_support(keyword) and key not in original_l:
            if key in rewritten_l:
                rejected.append(keyword)
                reasons.append(f"unsupported_domain_keyword:{keyword}")
            continue
        if key in rewritten_l:
            supported.append(keyword)

    rejected = _dedupe_case(rejected)
    supported = [kw for kw in _dedupe_case(supported) if kw.lower() not in {r.lower() for r in rejected}]
    return {
        "accepted": not rejected,
        "keywords_supported": supported,
        "keywords_rejected": rejected,
        "reasons": reasons,
    }
```

Add helper:

```python
def _dedupe_case(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        key = value.lower()
        if key not in seen:
            seen.add(key)
            out.append(value)
    return out
```

- [ ] Step 4: Wire validator into `rewrite_bullet_targeted()`.

After parsing model response:

```python
            validation = validate_rewrite_grounding(
                original=bullet,
                rewritten=text,
                requested_keywords=keywords,
            )
            result["validation"] = validation
            if not validation["accepted"]:
                result["bullet"] = bullet
                result["success"] = False
                result["error"] = "rewrite_validation_failed"
                result["keywords_used"] = validation["keywords_supported"]
                result["keywords_skipped"] = validation["keywords_rejected"] or list(keywords)
                return result
```

Important: In `ad_hoc_pipeline.py`, only update a bullet when `result["success"]` is true. Rejected keywords are already appended to `skipped_candidates` and will move to summary.

- [ ] Step 5: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py tests/test_ad_hoc_pipeline.py -q
```

- [ ] Step 6: Commit.

```powershell
git add fletcher/llm/llm_enrich.py fletcher/ad_hoc_pipeline.py tests/test_rewrite_validation.py tests/test_ad_hoc_pipeline.py
git commit -m "Reject unsupported bullet rewrites"
```

## Task 6: Add Optional LLM Rewrite Validator for Ambiguous Cases

Files: Modify `fletcher/llm/llm_enrich.py`, `tests/test_rewrite_validation.py`.

- [ ] Step 1: Write tests that monkeypatch `_ollama_chat()`.

```python
def test_llm_validator_rejects_unsupported_claim(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        mod,
        "_ollama_chat",
        lambda _prompt: '{"accepted": false, "keywords_supported": [], "keywords_rejected": ["Infrastructure as Code"], "reason": "Original only mentions Vercel and Supabase."}',
    )

    result = mod.validate_rewrite_with_ollama(
        original="Optimized scalability on Vercel and Supabase.",
        rewritten="Optimized scalability on Vercel and Supabase using Infrastructure as Code practices.",
        requested_keywords=["Infrastructure as Code"],
    )

    assert result["accepted"] is False
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py -q
```

- [ ] Step 3: Implement `validate_rewrite_with_ollama()`.

```python
def validate_rewrite_with_ollama(
    *,
    original: str,
    rewritten: str,
    requested_keywords: list[str],
    logger: PipelineLogger | None = None,
) -> dict[str, Any]:
    if config.DEFAULT_MODEL_BACKEND != "ollama":
        return {"accepted": True, "keywords_supported": requested_keywords, "keywords_rejected": [], "reason": "validator_disabled"}
    prompt = (
        "Validate whether a rewritten resume bullet is fully supported by the original bullet.\n"
        f"Original bullet: {original}\n"
        f"Rewritten bullet: {rewritten}\n"
        f"Requested keywords: {', '.join(requested_keywords)}\n"
        "Reject if the rewrite adds unsupported technology usage, unsupported domain experience, or vague claims not implied by the original.\n"
        "Return only: {\"accepted\": boolean, \"keywords_supported\": [...], \"keywords_rejected\": [...], \"reason\": \"...\"}"
    )
    raw = _ollama_chat(prompt)
    parsed = _extract_json_object(raw)
    accepted = bool(parsed.get("accepted"))
    supported = parsed.get("keywords_supported") if isinstance(parsed.get("keywords_supported"), list) else []
    rejected = parsed.get("keywords_rejected") if isinstance(parsed.get("keywords_rejected"), list) else []
    return {
        "accepted": accepted,
        "keywords_supported": [str(k).strip() for k in supported if str(k).strip()],
        "keywords_rejected": [str(k).strip() for k in rejected if str(k).strip()],
        "reason": str(parsed.get("reason") or ""),
    }
```

- [ ] Step 4: Use LLM validator only for ambiguous keywords.

Call this only when:
- deterministic validator accepts, and
- requested keywords include `Infrastructure as Code`, `cloud infrastructure`, `AI-driven platform`, `real-time threat intelligence`, or other domain/stretch terms.

If LLM validator rejects, handle exactly like deterministic rejection.

- [ ] Step 5: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py tests/test_llm_enrich_logger.py -q
```

- [ ] Step 6: Commit.

```powershell
git add fletcher/llm/llm_enrich.py tests/test_rewrite_validation.py tests/test_llm_enrich_logger.py
git commit -m "Validate ambiguous bullet rewrites"
```

## Task 7: Update Logs and Pipeline Metadata

Files: Modify `fletcher/ad_hoc_pipeline.py`, `tests/test_ad_hoc_pipeline.py`.

- [ ] Step 1: Add tests that validation rejection is logged and skipped keyword moves to summary.

```python
def test_rejected_rewrite_keyword_moves_to_summary(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.rewrite_bullet_targeted.return_value = {
        "bullet": "Optimized bug detection speed by configuring Datadog metrics.",
        "success": False,
        "error": "rewrite_validation_failed",
        "duration_ms": 10,
        "keywords_used": [],
        "keywords_skipped": ["real-time threat intelligence"],
    }
    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [{"bullet_idx": 1, "keyword": "real-time threat intelligence", "score": 0.85}],
        "summary_keywords": ["Software Engineer"],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.generate_summary.return_value = {"summary": "Summary text.", "success": True}

    run_ad_hoc_pipeline(title="Software Engineer", description="job")

    assert "real-time threat intelligence" in base_mocks.generate_summary.call_args.args[2]
```

- [ ] Step 2: Run expected fail if current logging/skipped behavior is incomplete.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_ad_hoc_pipeline.py -q
```

- [ ] Step 3: Add log fields.

In `bullet_rewrite_done`, ensure these are logged:
- `validation`
- `keywords_used`
- `keywords_skipped`
- `error`

Add pipeline summary log:

```python
logger.step(
    "rewrite_validation_summary",
    rejected_keywords=_dedupe(skipped_candidates),
)
```

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_ad_hoc_pipeline.py -q
```

- [ ] Step 5: Commit.

```powershell
git add fletcher/ad_hoc_pipeline.py tests/test_ad_hoc_pipeline.py
git commit -m "Log rewrite validation results"
```

## Task 8: Final Verification and Manual Sophos Smoke

Files: No code files unless tests reveal bugs.

- [ ] Step 1: Run focused tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_title_inference.py tests/test_rewrite_validation.py tests/test_ad_hoc_pipeline.py tests/test_llm_enrich_logger.py tests/test_rag_drop_scoring.py -q
```

Expected: all pass.

- [ ] Step 2: Run C2 CI.

```powershell
.\.venv\Scripts\python.exe ci.py c2
```

Expected: pass.

- [ ] Step 3: Run shared quality.

```powershell
.\.venv\Scripts\python.exe quality.py shared
```

Expected: pass.

- [ ] Step 4: Redeploy.

```powershell
python deploy.py all
docker logs hunt-review-1 -f
```

- [ ] Step 5: Re-run Sophos JD.

Expected log improvements:
- `title` or `resolved_title`: `Software Engineer`
- `input_title`: `About Us` if paste still begins with heading
- `job_level`: `mid` or `junior_mid`
- Datadog rewrite rejected or unchanged, with `real-time threat intelligence` moved to summary.
- Next.js UI rewrite rejected or unchanged, with `AI-driven platform` moved to summary.
- `Infrastructure as Code` either maps to the Terraform/S3 bullet or moves to summary.
- Summary tone no longer says `Eager to apply diverse programming skills...to contribute immediately`.

- [ ] Step 6: Update vault.

Update:
- `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/ad-hoc-pipeline-v2-plan.md`
- `C:/Users/sushi/Documents/agentsvault/log.md`

- [ ] Step 7: Commit.

```powershell
git add docs/superpowers/plans/2026-05-05-c2-title-and-rewrite-truthfulness.md
git commit -m "Plan C2 truthfulness guardrails"
```

## Risks and Tradeoffs

- LLM title inference adds latency only if deterministic extraction fails. Keep deterministic first.
- LLM rewrite validation adds latency for ambiguous rewrites. Use deterministic validation first and call LLM validation only for stretch/domain terms.
- Strict validation may reduce keyword insertion. This is intentional: unsupported keywords should go to summary or be ignored, not fabricated into bullets.
- `Infrastructure as Code` is tricky because candidate has Terraform experience elsewhere. Prefer matching it to the Terraform/S3 bullet instead of Vercel/Supabase.

## Execution Options

1. Subagent-Driven: split title/classifier and rewrite-validation into separate workers.
2. Inline Execution: implement tasks sequentially in this session with tests after each task.

## Implementation Notes 2026-05-05

Implemented inline:
- Added deterministic title inference in `fletcher/jobs/title_inference.py`.
- Wired ad-hoc endpoint and pipeline to use inferred titles instead of first-line headings.
- Added `input_title` and resolved `title` to pipeline config logs.
- Fixed classifier level detection so title/high-signal experience phrases beat incidental text like `mentor interns`.
- Added deterministic keyword categories and rewrite grounding validation.
- Added optional Ollama validation for ambiguous/stretch rewrite terms.
- Ambiguous validation now fails closed: if validation errors, the rewrite is rejected and keywords are skipped to summary.
- Added rewrite validation logging in `bullet_rewrite_done` and `rewrite_validation_summary`.

Verification run:
- `.\.venv\Scripts\python.exe -m pytest tests\test_title_inference.py tests\test_rewrite_validation.py tests\test_ad_hoc_pipeline.py tests\test_component2_stage1.py tests\test_llm_enrich_logger.py tests\test_rag_drop_scoring.py -q`: 51 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed, 22 tests.
- `.\.venv\Scripts\python.exe quality.py shared`: passed.
