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

## V2.2 Remaining Quality Fixes Plan

Goal: Fix remaining keyword-accounting and summary-quality issues after V2.1 truthfulness guardrails.

Architecture: Keep the validator stack, but make keyword accounting source-of-truth based on validator output rather than model self-report. Add summary-level validation/tone checks so skipped domain keywords do not reappear as unsupported summary claims.

### Task 1: Fix Partial Multi-Keyword Rewrite Accounting

Files: Modify `fletcher/llm/llm_enrich.py`, `tests/test_rewrite_validation.py`.

- [ ] Step 1: Add failing test.

```python
def test_partial_rewrite_rejection_skips_all_unsupported_keywords(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        mod,
        "_ollama_chat",
        lambda _prompt: (
            '{"bullet": "Enhanced user engagement by building a React/Next.js UI '
            'for an AI-driven platform based on beta tester feedback.", '
            '"keywords_used": ["React", "AI-driven platform"], "keywords_skipped": []}'
        ),
    )

    result = mod.rewrite_bullet_targeted(
        "Enhanced user engagement by building a responsive UI using Next.js and Framer Motion based on beta tester feedback.",
        ["React", "AI-driven platform"],
    )

    assert result["success"] is False
    assert result["keywords_used"] == ["React"]
    assert result["keywords_skipped"] == ["AI-driven platform"]
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py -q
```

- [ ] Step 3: Implement support/skipped derivation.

Add helper:

```python
def _derive_keyword_outcome(
    requested: list[str],
    supported: list[str],
    rejected: list[str],
) -> tuple[list[str], list[str]]:
    supported_clean = _dedupe_case(supported)
    supported_l = {kw.lower() for kw in supported_clean}
    rejected_l = {kw.lower() for kw in _dedupe_case(rejected)}
    skipped = [
        kw for kw in requested
        if kw.lower() not in supported_l or kw.lower() in rejected_l
    ]
    return supported_clean, _dedupe_case(skipped)
```

When validation fails:

```python
used, skipped = _derive_keyword_outcome(
    keywords,
    validation.get("keywords_supported") or [],
    validation.get("keywords_rejected") or [],
)
result["keywords_used"] = used
result["keywords_skipped"] = skipped
```

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py tests/test_ad_hoc_pipeline.py -q
```

### Task 1A: Add Deterministic Claimed-Keyword Presence Check

Files: Modify `fletcher/llm/llm_enrich.py`, `tests/test_rewrite_validation.py`.

Rationale: The rewrite model can claim a keyword was used even when the rewritten bullet does not contain it. Example from Sophos smoke: model returned `keywords_used=["React", "AI-driven platform"]`, but the bullet only contained `Next.js` and `AI-driven platform`, not `React`.

Desired behavior:
- Validate the model's `keywords_used` before semantic validation.
- A claimed-used keyword must appear in the rewritten bullet exactly, or via an explicitly approved related phrase such as `React/Next.js`.
- Bare `Next.js` does not count as `React`; the rewritten output must visibly include `React` or `React/Next.js`.
- If any claimed-used keyword is missing, reject the entire rewrite, keep the original bullet, and move all requested keywords to `keywords_skipped`.

- [ ] Step 1: Add failing test.

```python
def test_claimed_keyword_must_appear_in_rewrite(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        mod,
        "_ollama_chat",
        lambda _prompt: (
            '{"bullet": "Enhanced user engagement by building a responsive UI using Next.js.", '
            '"keywords_used": ["React"], "keywords_skipped": []}'
        ),
    )

    result = mod.rewrite_bullet_targeted(
        "Enhanced user engagement by building a responsive UI using Next.js.",
        ["React"],
    )

    assert result["success"] is False
    assert result["error"] == "claimed_keyword_missing"
    assert result["bullet"] == "Enhanced user engagement by building a responsive UI using Next.js."
    assert result["keywords_used"] == []
    assert result["keywords_skipped"] == ["React"]
```

- [ ] Step 2: Implement helper.

```python
RELATED_VISIBLE_PHRASES = {
    "react": ("react", "react/next.js", "next.js/react"),
}

def validate_claimed_keywords_present(
    *,
    rewritten: str,
    requested_keywords: list[str],
    claimed_used: list[str],
) -> dict[str, Any]:
    rewritten_l = rewritten.lower()
    missing = []
    requested_l = {kw.lower() for kw in requested_keywords}
    for keyword in claimed_used:
        key = keyword.lower()
        if key not in requested_l:
            missing.append(keyword)
            continue
        allowed = RELATED_VISIBLE_PHRASES.get(key, (key,))
        if not any(phrase in rewritten_l for phrase in allowed):
            missing.append(keyword)
    return {"accepted": not missing, "missing": _dedupe_case(missing)}
```

- [ ] Step 3: Wire into `rewrite_bullet_targeted()` before semantic validation.

```python
claimed_used = parsed.get("keywords_used") if isinstance(parsed.get("keywords_used"), list) else []
presence = validate_claimed_keywords_present(
    rewritten=text,
    requested_keywords=keywords,
    claimed_used=[str(k).strip() for k in claimed_used if str(k).strip()],
)
result["claimed_keyword_presence"] = presence
if not presence["accepted"]:
    result["bullet"] = bullet
    result["success"] = False
    result["error"] = "claimed_keyword_missing"
    result["keywords_used"] = []
    result["keywords_skipped"] = list(keywords)
    return result
```

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py tests/test_ad_hoc_pipeline.py -q
```

### Task 2: Trust Validator-Supported Keywords Over Model Self-Report

Files: Modify `fletcher/llm/llm_enrich.py`, `tests/test_rewrite_validation.py`.

- [ ] Step 1: Add failing test.

```python
def test_model_claimed_keyword_not_counted_if_not_in_validated_rewrite(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        mod,
        "_ollama_chat",
        lambda _prompt: (
            '{"bullet": "Enhanced user engagement by building a responsive UI using Next.js.", '
            '"keywords_used": ["React"], "keywords_skipped": []}'
        ),
    )

    result = mod.rewrite_bullet_targeted(
        "Enhanced user engagement by building a responsive UI using Next.js.",
        ["React"],
    )

    assert result["success"] is False
    assert result["keywords_used"] == []
    assert result["keywords_skipped"] == ["React"]
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py -q
```

- [ ] Step 3: Change accepted path.

After validation:

```python
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

result["keywords_used"] = used
result["keywords_skipped"] = skipped
```

Do not use parsed `keywords_used` as authoritative. It can remain only as diagnostic metadata:

```python
result["model_keywords_used"] = parsed.get("keywords_used")
result["model_keywords_skipped"] = parsed.get("keywords_skipped")
```

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py tests/test_llm_enrich_logger.py -q
```

### Task 3: Retry Safe Keywords Individually After Mixed Failure

Files: Modify `fletcher/ad_hoc_pipeline.py`, `tests/test_ad_hoc_pipeline.py`.

- [ ] Step 1: Add failing pipeline test.

```python
def test_partial_rewrite_safe_keyword_gets_second_chance(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [{"bullet_idx": 3, "keyword": "React", "score": 0.9}, {"bullet_idx": 3, "keyword": "AI-driven platform", "score": 0.91}],
        "summary_keywords": [],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.rewrite_bullet_targeted.side_effect = [
        {
            "bullet": "original",
            "success": False,
            "error": "rewrite_validation_failed",
            "duration_ms": 1,
            "keywords_used": ["React"],
            "keywords_skipped": ["AI-driven platform"],
        },
        {
            "bullet": "Enhanced user engagement by building a React/Next.js UI.",
            "success": True,
            "error": None,
            "duration_ms": 1,
            "keywords_used": ["React"],
            "keywords_skipped": [],
        },
    ]

    run_ad_hoc_pipeline(title="Software Engineer", description="React job")

    assert base_mocks.rewrite_bullet_targeted.call_count == 2
    assert base_mocks.rewrite_bullet_targeted.call_args_list[1].args[1] == ["React"]
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_ad_hoc_pipeline.py -q
```

- [ ] Step 3: Implement one safe-keyword retry.

In `_run_iteration()`, when a rewrite fails but returns `keywords_used`, retry only `keywords_used` once:

```python
retry_keywords = result.get("keywords_used") or []
if not result["success"] and retry_keywords:
    retry_result = rewrite_bullet_targeted(
        original_text,
        retry_keywords,
        keywords_to_preserve=kws_to_preserve,
        logger=logger,
    )
    logger.step("bullet_rewrite_retry_done", ...)
    if retry_result["success"]:
        result = retry_result
```

Keep rejected keywords from the first result in `skipped_candidates`.

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_ad_hoc_pipeline.py -q
```

### Task 4: Add Summary Tone Guardrails

Files: Modify `fletcher/llm/llm_enrich.py`, `tests/test_llm_enrich_logger.py`.

- [ ] Step 1: Add prompt test.

```python
def test_summary_prompt_bans_junior_tone(monkeypatch):
    monkeypatch.setattr("fletcher.llm.llm_enrich.config.DEFAULT_MODEL_BACKEND", "ollama")
    captured = []

    def fake_chat(prompt: str) -> str:
        captured.append(prompt)
        return '{"summary": "Software developer with backend experience."}'

    with patch("fletcher.llm.llm_enrich._ollama_chat", fake_chat):
        generate_summary("context", "Software Engineer", ["backend services"])

    assert "Do not use junior-sounding filler" in captured[0]
    assert "motivated" in captured[0].lower()
    assert "eager" in captured[0].lower()
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_llm_enrich_logger.py -q
```

- [ ] Step 3: Update summary prompt.

Add:

```python
f"Use a grounded mid-level software engineering tone. "
f"Do not use junior-sounding filler such as motivated, eager, passionate, aspiring, contribute immediately, or diverse programming skills. "
f"Prefer concrete experience over enthusiasm. "
```

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_llm_enrich_logger.py -q
```

### Task 5: Add Summary Claim Validation

Files: Modify `fletcher/llm/llm_enrich.py`, `fletcher/ad_hoc_pipeline.py`, `tests/test_llm_enrich_logger.py`, `tests/test_ad_hoc_pipeline.py`.

- [ ] Step 1: Add deterministic validator tests.

```python
from fletcher.llm.llm_enrich import validate_summary_grounding


def test_summary_rejects_unsupported_domain_claim():
    result = validate_summary_grounding(
        summary="Software Engineer with XDR and real-time threat intelligence experience.",
        candidate_context="Experience: Software Developer. Skills: Python, React, Terraform",
        keywords=["XDR", "real-time threat intelligence"],
    )
    assert result["accepted"] is False


def test_summary_rejects_junior_tone():
    result = validate_summary_grounding(
        summary="Motivated developer eager to contribute immediately.",
        candidate_context="Experience: Software Developer.",
        keywords=[],
    )
    assert result["accepted"] is False
```

- [ ] Step 2: Implement `validate_summary_grounding()`.

```python
SUMMARY_BANNED_TONE = ("motivated", "eager", "passionate", "aspiring", "contribute immediately", "diverse programming skills")

def validate_summary_grounding(summary: str, candidate_context: str, keywords: list[str]) -> dict[str, Any]:
    summary_l = summary.lower()
    context_l = candidate_context.lower()
    reasons = []
    for phrase in SUMMARY_BANNED_TONE:
        if phrase in summary_l:
            reasons.append(f"banned_tone:{phrase}")
    for keyword in keywords:
        key = keyword.lower()
        if keyword_requires_direct_support(keyword) and key in summary_l and key not in context_l:
            reasons.append(f"unsupported_summary_domain:{keyword}")
    return {"accepted": not reasons, "reasons": reasons}
```

- [ ] Step 3: Wire validation into summary generation path.

After `generate_summary()` returns success in `_run_iteration()`:

```python
summary_validation = validate_summary_grounding(
    summary_meta.get("summary", ""),
    candidate_context,
    mid_keywords,
)
logger.step("summary_validation", **summary_validation)
if not summary_validation["accepted"]:
    summary_meta = generate_summary(..., line_feedback="Revise to remove unsupported domain claims and junior-sounding filler.")
```

If retry still fails validation:

```python
summary_meta = {"summary": "", "success": False, "error": "summary_validation_failed"}
```

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_llm_enrich_logger.py tests/test_ad_hoc_pipeline.py -q
```

## Implemented Checkpoint: LLM-Assisted Policy Routing

Implemented:
- Added an optional Ollama policy-router call for ambiguous keywords that deterministic policy would otherwise classify as `ignore:unknown`.
- Deterministic policy still runs first and remains the fallback, but unknown role-relevant terms can now be rescued into `rewrite`, `summary`, or `skills_only`.
- Expanded deterministic full-stack coverage so `.NET`, `Angular`, `MS SQL Server`, `PrimeNG`, `LINQ`, `Angular and TypeScript`, full development lifecycle, write tests, fix defects, codebase review, clean maintainable code, object-oriented design, and debugging terms no longer disappear by default.
- Kept hard safety categories as deterministic guardrails: job titles, education credentials, org metadata, logistics, and unsupported language requirements still cannot become bullet rewrites just because an LLM says so.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_keyword_policy.py tests\test_ad_hoc_pipeline.py tests\test_rewrite_validation.py tests\test_llm_enrich_logger.py -q`: 83 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.

## Implemented Checkpoint: More LLM Judgment, Fewer Rigid Text Rules

Implemented:
- Title recovery now uses deterministic inference first, then an Ollama title extraction fallback when the title is empty or suspicious.
- Job classification now uses deterministic classification first, then an Ollama classification fallback when role family or level is weak, general, or unknown.
- Added explicit `JobMismatchError` result behavior when the detected role family or seniority is clearly incompatible with the submitted/requested title.
- Summary keyword filtering now uses an Ollama judgment call first, with deterministic filtering only as fallback.
- Summary validation now uses an Ollama judgment call first, with deterministic validation only as fallback.
- Bullet rewrite validation now follows this shape: one LLM rewrite, one deterministic claimed-keyword visibility check, one LLM validation check, one LLM repair attempt if validation fails, then the same visibility and LLM validation checks once more. If the repair still fails, the original bullet is kept and skipped keywords move onward.
- Removed deterministic phrasing repair from the active rewrite path. The old helper remains for existing tests but no longer changes rewrite output before validation.
- Medium summary keywords that are skill-like can now be added to the bottom skills section. No-summary versions can use all medium skill-like keywords, while with-summary versions add skill-like summary keywords that did not visibly land in the generated summary.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_keyword_policy.py tests\test_ad_hoc_pipeline.py tests\test_rewrite_validation.py tests\test_llm_enrich_logger.py -q`: 83 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.

## Implemented Checkpoint: Combined Job Fit Check and LLM Skill Bucketing

Implemented:
- Replaced separate suspicious-title and mismatch checks with one Ollama `analyze_job_fit` call that extracts the actual title, classifies the role, and decides whether the JD clearly mismatches the requested title.
- Simplified claimed keyword visibility for normal terms: the normalized keyword must be visibly present in the rewritten text. Punctuation and casing are fine. Approved related-tech variants such as `Next.js` for `React` are no longer used.
- Kept action-phrase inflection support for phrases such as `Monitor data pipelines` because it preserves the same action and object rather than using a different technology synonym.
- Moved Technical Skills bucket assignment to Ollama with no deterministic skill-bucket fallback. If the skill bucketing LLM call fails, no extra skills are added.
- Removed role-aware drop-score bonuses. Drop ordering now uses embedding relevance only.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_keyword_policy.py tests\test_ad_hoc_pipeline.py tests\test_rewrite_validation.py tests\test_llm_enrich_logger.py -q`: 83 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.

## V2.5 Keyword Policy Implementation 2026-05-05

Implemented:
- Added `fletcher/jobs/keyword_policy.py` with `KeywordKind`, `KeywordRoute`, `KeywordPolicy`, and `classify_keyword_policy()`.
- Routed missing keywords through policy before RAG. Only rewrite-eligible signals reach `match_keywords_to_bullets()`.
- Added `keyword_policy_partition` logs with rewrite, summary-only, skills-only, ignored, and reason fields.
- Kept job titles, org metadata, logistics, language requirements without resume support, and education/credential terms out of bullet rewrites.
- Added deterministic title recovery from role-like extracted keywords when title inference returns empty.
- Extended title inference for `We are looking for Database Software Developer interns` and normalized plural `interns` to `Intern`.
- Updated rewrite validation so same-category CI/CD tool phrasing can pass, while cross-vendor cloud resource conflicts, Databricks-from-Datadog substitutions, and unsupported process claims fail.
- Added role-specific summary prompt strategy for PM, data, intern, and software roles.
- Removed role-aware drop-score bonuses in the later combined job-fit pass. Drop ordering now uses embedding relevance only.
- Extended Option B smoke output with `quality_notes.json`.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_keyword_policy.py tests\test_title_inference.py tests\test_rewrite_validation.py tests\test_ad_hoc_pipeline.py tests\test_component2_stage1.py tests\test_llm_enrich_logger.py tests\test_rag_drop_scoring.py tests\test_option_b_smoke.py -q`: 98 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.
- `.\.venv\Scripts\python.exe quality.py shared`: passed.

Still planned:
- Run deployed Option B smokes across several enriched jobs and compare PDFs/logs.
- Revalidate or regenerate summaries if the later drop loop removes evidence used by the summary.

## V2.3 Keyword Policy and Ambiguity Control Plan

Goal: Make C2 stop treating every extracted JD phrase as a bullet-rewrite keyword, and instead route each keyword by type, evidence, and safe destination.

Architecture: Add a deterministic keyword policy layer between keyword extraction and RAG. The policy labels each extracted phrase with a kind and allowed destinations: bullet rewrite, summary, education/context only, or ignore. RAG should only receive bullet-rewrite-eligible terms for bullet matching. Summary generation should receive only summary-eligible terms plus top retained bullet evidence.

Tech Stack: Python, pytest, existing Fletcher pipeline, Ollama JSON chat.

### What Is Wrong Currently

1. Flat keyword list causes category confusion
- Current behavior: `Computer Engineering`, `Software Development Intern`, `Azure DevOps`, `code reviews`, and `multi-threaded parallel processing` all enter roughly the same pipeline.
- Why this is wrong: these phrases are different objects. Some are job titles, some are education credentials, some are tools, some are process terms, some are domain claims.
- Impact: RAG can match an education term to a teaching bullet, then the rewrite model tries to insert a claim that does not belong.

2. RAG answers similarity, not rewrite safety
- Current behavior: RAG says `Computer Engineering` is high-match because it is near a `Computer Science` teaching bullet.
- Why this is wrong: semantic similarity does not mean the phrase is safe to insert.
- Impact: the model tried to rewrite `Computer Science courses` into `Computer Science and Computer Engineering courses`, which is false.

3. Job title and role keywords are allowed too far downstream
- Current behavior: job title phrases such as `Software Development Intern` can become keywords.
- Why this is wrong: job titles should shape title inference, classification, and summary tone. They should never be inserted into bullets.
- Impact: the system risks writing unnatural bullets like `built Software Development Intern features`.

4. Credential and education terms need their own destination
- Current behavior: `Computer Science`, `Computer Engineering`, and `Mathematics` can be treated as candidate rewrite keywords.
- Desired behavior: never rewrite bullets with these terms. They may be used for education matching or summary context only.

5. Tool substitution is under-specified
- User policy: if feasible, keep both tools. Otherwise tool substitution can be acceptable only when it matches the rest of the bullet.
- Risk: direct tool substitution can become a false claim. Example: a bullet about AWS S3 cost savings should not become an Azure cloud bullet.
- Needed rule: tool substitution needs same tool category, same activity, no vendor/resource conflict, and no claim of direct use unless the tool was actually used.

6. Process terms need evidence thresholds
- User policy: direct evidence required for bullets, softer wording allowed in summary when supported by retained bullets.
- Current risk: `code reviews` can be forced into a grading automation bullet because it is software-process-adjacent.
- Needed rule: process terms like `unit testing`, `code reviews`, `scrum`, and `source repository processes` require direct or strong nearby evidence for bullet rewrites.

7. Domain terms need direct evidence
- User policy: domain terms require direct evidence in the bullet. Do not fit `robotics` into an unrelated self-hosted LLM bullet just because there is loose correlation.
- Needed rule: domain terms are bullet-eligible only when the original bullet is already in that domain or explicitly names the domain.

8. The LLM should skip more often
- User policy: if the model is not at least 70 percent comfortable, skip the keyword.
- Current issue: prompts say not to force, but the model still tries.
- Needed rule: rewrite output must include a confidence field per keyword, and the pipeline rejects any keyword under threshold.

9. Summary context is too thin
- Current behavior: summary sees titles and skills, not top retained bullet evidence.
- Impact: summary can sound broad or generic, especially for process terms like `unit testing`.
- Needed rule: summary prompt should include top retained bullets relevant to summary keywords, so claims are grounded.

### Policy Decisions Captured

- Tool substitution: allowed only when same category, same activity, no vendor/resource conflict, and wording remains truthful. Prefer keeping both tools when feasible.
- Credential and education terms: never insert into bullets.
- Process terms: direct evidence required for bullets. Softer summary wording allowed when supported by retained bullets.
- Job title keywords: never insert into bullets.
- Domain terms: direct bullet evidence required. Skip if not clearly related.
- LLM confidence: require 70 percent or higher per keyword; otherwise skip.

### Task 1: Create Keyword Policy Layer

Files: Create `fletcher/jobs/keyword_policy.py`, create `tests/test_keyword_policy.py`.

- [ ] Step 1: Write tests.

```python
from fletcher.jobs.keyword_policy import classify_keyword_policy


def test_job_title_is_summary_only_not_rewrite():
    policy = classify_keyword_policy("Software Development Intern")
    assert policy.kind == "role_title"
    assert policy.allow_bullet_rewrite is False
    assert policy.allow_summary is True


def test_education_terms_never_rewrite():
    for keyword in ["Computer Science", "Computer Engineering", "Mathematics"]:
        policy = classify_keyword_policy(keyword)
        assert policy.kind == "education"
        assert policy.allow_bullet_rewrite is False


def test_named_tool_is_rewrite_candidate_but_requires_evidence():
    policy = classify_keyword_policy("Azure DevOps")
    assert policy.kind == "tool"
    assert policy.allow_bullet_rewrite is True
    assert policy.requires_evidence is True


def test_process_terms_need_evidence_for_bullets():
    for keyword in ["unit testing", "code reviews", "source repository processes"]:
        policy = classify_keyword_policy(keyword)
        assert policy.kind == "process"
        assert policy.allow_bullet_rewrite is True
        assert policy.requires_evidence is True


def test_domain_terms_require_direct_evidence():
    for keyword in ["robotics", "3D graphics", "cybersecurity", "AI-driven platform"]:
        policy = classify_keyword_policy(keyword)
        assert policy.kind == "domain"
        assert policy.allow_bullet_rewrite is True
        assert policy.requires_direct_evidence is True
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_keyword_policy.py -q
```

- [ ] Step 3: Implement policy dataclass and classifier.

```python
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class KeywordPolicy:
    keyword: str
    kind: str
    allow_bullet_rewrite: bool
    allow_summary: bool
    requires_evidence: bool = True
    requires_direct_evidence: bool = False


ROLE_TITLE_TERMS = {"intern", "engineer", "developer", "manager", "analyst", "specialist"}
EDUCATION_TERMS = {"computer science", "computer engineering", "mathematics"}
PROCESS_TERMS = {
    "unit testing",
    "unit",
    "integration",
    "end-to-end",
    "code reviews",
    "scrum",
    "source repository processes",
    "full life cycle development",
}
DOMAIN_TERMS = {
    "robotics",
    "3d graphics",
    "cybersecurity",
    "ai-driven platform",
    "real-time threat intelligence",
    "xdr",
    "mdr",
    "itdr",
    "siem",
}
TOOL_TERMS = {"azure devops", "git", "wpf", "c#", "terraform", "react", "typeScript".lower()}


def classify_keyword_policy(keyword: str) -> KeywordPolicy:
    value = (keyword or "").strip()
    key = value.lower()
    words = set(key.replace("-", " ").split())
    if key in EDUCATION_TERMS:
        return KeywordPolicy(value, "education", False, True, requires_evidence=False)
    if "software" in words and words & ROLE_TITLE_TERMS:
        return KeywordPolicy(value, "role_title", False, True, requires_evidence=False)
    if key in DOMAIN_TERMS:
        return KeywordPolicy(value, "domain", True, True, True, True)
    if key in PROCESS_TERMS:
        return KeywordPolicy(value, "process", True, True, True, False)
    if key in TOOL_TERMS or any(ch in value for ch in ("#", "+")):
        return KeywordPolicy(value, "tool", True, True, True, False)
    return KeywordPolicy(value, "unknown", False, True, requires_evidence=True)
```

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_keyword_policy.py -q
```

### Task 2: Route Keywords Before RAG

Files: Modify `fletcher/ad_hoc_pipeline.py`, modify `tests/test_ad_hoc_pipeline.py`.

- [ ] Step 1: Write tests.

```python
def test_rag_only_receives_bullet_rewrite_eligible_keywords(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.enrich_with_ollama_if_enabled.return_value = (
        {},
        {"must_have_terms": ["Software Development Intern", "Computer Engineering", "Azure DevOps", "unit testing"]},
        {"ollama_enriched": True},
    )
    base_mocks.partition_keywords.return_value = (
        [],
        ["Software Development Intern", "Computer Engineering", "Azure DevOps", "unit testing"],
        {},
    )

    run_ad_hoc_pipeline(title="Software Development Intern", description="job")

    rag_keywords = base_mocks.match_keywords_to_bullets.call_args.args[0]
    assert "Software Development Intern" not in rag_keywords
    assert "Computer Engineering" not in rag_keywords
    assert "Azure DevOps" in rag_keywords
    assert "unit testing" in rag_keywords
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_ad_hoc_pipeline.py -q
```

- [ ] Step 3: Add policy routing in `_run_iteration()`.

Implementation shape:

```python
from .jobs.keyword_policy import classify_keyword_policy

rewrite_missing_kws = [
    kw for kw in missing_kws
    if classify_keyword_policy(kw).allow_bullet_rewrite
]
summary_only_kws = [
    kw for kw in missing_kws
    if not classify_keyword_policy(kw).allow_bullet_rewrite
    and classify_keyword_policy(kw).allow_summary
]
logger.step("keyword_policy_partition", rewrite=rewrite_missing_kws, summary_only=summary_only_kws)
```

Use `rewrite_missing_kws` for `match_keywords_to_bullets()`.

Add `summary_only_kws` to the summary keyword pool after filtering.

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_ad_hoc_pipeline.py tests/test_keyword_policy.py -q
```

### Task 3: Add Tool Substitution Guard

Files: Modify `fletcher/llm/llm_enrich.py`, create/update `tests/test_rewrite_validation.py`.

- [ ] Step 1: Write tests.

```python
from fletcher.llm.llm_enrich import validate_rewrite_grounding


def test_rejects_cross_vendor_cloud_tool_substitution():
    result = validate_rewrite_grounding(
        original="Reduced AWS S3 storage costs by optimizing lifecycle policies.",
        rewritten="Reduced AWS S3 storage costs by optimizing Azure cloud lifecycle policies.",
        requested_keywords=["Azure"],
    )
    assert result["accepted"] is False


def test_rejects_unrelated_tool_claim_in_ci_bullet():
    result = validate_rewrite_grounding(
        original="Automated CI/CD via Bitbucket pipelines and ECR/Kubernetes.",
        rewritten="Automated CI/CD via Azure DevOps, Bitbucket pipelines, and ECR/Kubernetes.",
        requested_keywords=["Azure DevOps"],
    )
    assert result["accepted"] is False
```

- [ ] Step 2: Run expected fail or confirm current behavior.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py -q
```

- [ ] Step 3: Add deterministic conflict checks before LLM validation.

Implementation shape:

```python
CLOUD_VENDOR_TERMS = {"aws", "azure", "gcp"}

def _has_vendor_conflict(original_l: str, rewritten_l: str, keyword_l: str) -> bool:
    if keyword_l == "azure" and "aws" in original_l and "azure" in rewritten_l:
        return True
    if keyword_l == "azure devops" and "bitbucket" in original_l and "azure devops" in rewritten_l:
        return True
    return False
```

If conflict detected, reject keyword.

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py -q
```

### Task 4: Add 70 Percent Keyword Confidence

Files: Modify `fletcher/llm/llm_enrich.py`, modify `tests/test_rewrite_validation.py`.

- [ ] Step 1: Write tests.

```python
def test_low_confidence_keyword_is_rejected(monkeypatch):
    import fletcher.llm.llm_enrich as mod

    monkeypatch.setattr(mod.config, "DEFAULT_MODEL_BACKEND", "ollama")
    monkeypatch.setattr(
        mod,
        "_ollama_chat",
        lambda _prompt: (
            '{"bullet": "Automated CI/CD with Azure DevOps-like workflows.", '
            '"keywords_used": ["Azure DevOps"], "keywords_skipped": [], '
            '"keyword_confidence": {"Azure DevOps": 0.55}}'
        ),
    )

    result = mod.rewrite_bullet_targeted(
        "Automated CI/CD via Bitbucket pipelines.",
        ["Azure DevOps"],
    )

    assert result["success"] is False
    assert result["keywords_skipped"] == ["Azure DevOps"]
```

- [ ] Step 2: Update rewrite prompt return schema.

```text
Return only:
{"bullet": "...", "keywords_used": [...], "keywords_skipped": [...], "keyword_confidence": {"keyword": 0.0}}
```

Prompt rule:

```text
For each keyword, include confidence from 0.0 to 1.0. Use a keyword only when confidence is at least 0.70. If below 0.70, put it in keywords_skipped.
```

- [ ] Step 3: Enforce confidence after parse.

```python
confidence = parsed.get("keyword_confidence") if isinstance(parsed.get("keyword_confidence"), dict) else {}
low_confidence = [
    kw for kw in claimed_used
    if float(confidence.get(kw, 0.0)) < 0.70
]
if low_confidence:
    result["error"] = "keyword_confidence_too_low"
    result["keywords_skipped"] = list(keywords)
    return result
```

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_rewrite_validation.py -q
```

### Task 5: Add Retained Bullet Evidence to Summary Context

Files: Modify `fletcher/ad_hoc_pipeline.py`, modify `tests/test_ad_hoc_pipeline.py`.

- [ ] Step 1: Write tests.

```python
def test_summary_context_includes_top_retained_bullets(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.generate_summary.return_value = {"summary": "Summary text.", "success": True}
    run_ad_hoc_pipeline(title="Software Engineer", description="job")

    candidate_context = base_mocks.generate_summary.call_args.args[0]
    assert "Relevant evidence:" in candidate_context
```

- [ ] Step 2: Implement context helper.

```python
def _build_summary_evidence(doc, scores: dict[str, float], active_bucket_ids: list[BucketId]) -> list[str]:
    bullets, sources = _collect_active_bullets(doc, active_bucket_ids)
    ranked = sorted(
        zip(bullets, sources),
        key=lambda pair: scores.get(pair[1]["bullet_id"], 0.0),
        reverse=True,
    )
    return [bullet for bullet, _source in ranked[:5]]
```

Append to candidate context:

```python
evidence = _build_summary_evidence(doc, scores, active_bucket_ids)
if evidence:
    candidate_context += ". Relevant evidence: " + " | ".join(evidence)
```

- [ ] Step 3: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_ad_hoc_pipeline.py -q
```

### Task 6: Fix Title and Level Ambiguity Broadly

Files: Modify `fletcher/jobs/title_inference.py`, `fletcher/jobs/classifier.py`, update tests.

- [ ] Step 1: Expand title tests.

```python
def test_title_inference_accepts_non_swe_titles():
    assert normalize_title_candidate("Data Scientist") == "Data Scientist"
    assert normalize_title_candidate("QA Tester") == "QA Tester"
    assert normalize_title_candidate("Technical Writer") == "Technical Writer"


def test_currently_pursuing_needs_student_context():
    from fletcher.jobs.classifier import classify_job

    result = classify_job(
        title="Software Engineer",
        description="Currently pursuing SOC 2 compliance improvements with senior engineers.",
    )
    assert result["job_level"] != "intern"
```

- [ ] Step 2: Replace small title term gate with plausible-title rejection.

Implementation direction:
- Keep metadata rejection.
- Keep section heading rejection.
- Reject long lines.
- Accept short title-shaped lines with title-case or known role nouns.
- Use LLM fallback only when deterministic inference returns empty and Ollama is available.

- [ ] Step 3: Make level detection scored instead of first-match.

Implementation direction:
- Title evidence has highest weight.
- `currently pursuing` counts as intern only near degree/student terms.
- `senior developers` is collaborator context, not senior-level evidence.
- `few years`, `moderate guidance`, `own delivery` count as mid-level.

### Final Verification

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_keyword_policy.py tests/test_title_inference.py tests/test_rewrite_validation.py tests/test_ad_hoc_pipeline.py tests/test_component2_stage1.py tests/test_llm_enrich_logger.py tests/test_rag_drop_scoring.py -q
.\.venv\Scripts\python.exe ci.py c2
.\.venv\Scripts\python.exe quality.py shared
```

### Clarifications Still Needed Before Implementation

1. Tool substitution wording:
- Should the resume explicitly name a tool the candidate did not use if it is same-category, for ATS?
- Safer default: only mention the requested tool in a comparative or adjacent way, not as direct use. Example: `CI/CD workflows comparable to Azure DevOps pipelines` instead of `using Azure DevOps`.

2. Summary aggressiveness:
- Should the summary include summary-only keywords like `Software Development Intern`, `unit testing`, and `source repository processes` even if not directly in retained bullets?
- Safer default: role title yes, process terms only when supported by retained bullets or skills.

3. Domain exposure language:
- Should summary ever say `exposure to robotics` if the resume has no robotics evidence but the JD asks for it?
- Safer default: no.

## V2.2 Implementation Notes 2026-05-05

Implemented:
- Every successful-looking bullet rewrite now goes through semantic LLM validation after deterministic checks.
- Claimed keyword metadata is no longer trusted unless the keyword visibly appears in the rewritten bullet or an approved visible related phrase such as `React/Next.js`.
- Validator-supported keywords are now authoritative. Model-reported `keywords_used` / `keywords_skipped` are kept only as diagnostics.
- Mixed rewrite failures preserve the safe subset and retry it once. Example: `React` can be retried when `AI-driven platform` is rejected.
- Summary keyword selection now filters both mid-tier keywords and skipped rewrite keywords, excluding unsupported domain/security terms such as `XDR`, `real-time threat intelligence`, and `AI-driven platform`.
- Summary prompt now asks for supported keywords only and bans junior-sounding filler such as `motivated`, `eager`, and `contribute immediately`.
- Summary output is validated for banned tone and unsupported direct domain claims. One retry is attempted; if it still fails, the summary artifact is skipped.
- Redundant `Kotlin microservices and backend services` phrasing is repaired to `backend Kotlin microservices` before validation.
- Pipeline logs now include monotonic `event_id` values for step and LLM entries.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_title_inference.py tests\test_rewrite_validation.py tests\test_ad_hoc_pipeline.py tests\test_component2_stage1.py tests\test_llm_enrich_logger.py tests\test_rag_drop_scoring.py -q`: 63 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed, 22 tests.
- `.\.venv\Scripts\python.exe quality.py shared`: passed.

## V2.4 Plan: Keyword Policy, Tool Substitution, and Clear Logs

Goal: Make keyword insertion less ambiguous by deciding each keyword's allowed destination before RAG/rewrite, then make live logs easier to read with visible separators and higher precision timing.

Architecture: Add one policy module that classifies JD keywords into actionable buckets. The ad-hoc pipeline will use that policy before RAG, the rewrite prompt will receive policy guidance, the validators will enforce the same policy, and the summary builder will only use summary-eligible keywords backed by resume evidence. Logging stays centralized in `PipelineLogger`.

Tech Stack: Python, pytest, existing Fletcher pipeline, Ollama JSON chat, existing resume parser and RAG embeddings.

### User Decisions Captured

- Tool substitution: allowed when the candidate used a similar or close tool, a similar workflow, or already uses the requested ecosystem elsewhere. The rewrite must still fit the rest of the bullet.
- Tool substitution conflict: reject if the requested tool conflicts with concrete facts already in the bullet. Example: do not claim Azure cloud work in a bullet about AWS S3 cost savings.
- Credential and education terms: never write them into bullets. Example: `Computer Engineering`, `Mathematics`, and degree requirements should not be injected into work bullets.
- Process terms: only write into bullets when the original bullet directly supports the process. Summary can mention process terms only when retained bullets or skills support them.
- Job title keywords: never write into bullets. Use them for classification, targeting, and summary tone only.
- Domain terms: require direct evidence in the same bullet for bullet rewrite. Do not fit loosely related domains into unrelated work.
- Confidence threshold: the model should skip a keyword unless it is at least 70 percent comfortable that the keyword belongs.

### Current Problems

- Keyword handling is scattered: `NON_REWRITE_KEYWORDS`, `SUMMARY_GENERIC_KEYWORDS`, `DOMAIN_KEYWORDS`, and validator examples live in different files and can disagree.
- RAG still tries to match keywords that should never become bullet rewrites, such as education terms, job titles, and unsupported process terms.
- The validator can reject a rewrite after one or two expensive LLM calls, but the pipeline should avoid trying obviously bad rewrites before the model call.
- Tool substitution is not modeled explicitly. `Azure DevOps` versus `Bitbucket pipelines` needs a same-category decision, while `Azure` versus `AWS S3` needs a conflict decision.
- The rewrite prompt does not yet expose a formal 70 percent confidence contract.
- Summary context is too thin. It mostly includes titles and skills, so summaries can become generic when bullet rewrites are rejected.
- Logs have event IDs, but live output is visually dense. Timestamps use only two decimals, so adjacent steps look like they happened at exactly the same time.

### New Policy Model

Create `fletcher/jobs/keyword_policy.py`.

```python
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class KeywordKind(str, Enum):
    ROLE_TITLE = "role_title"
    EDUCATION = "education"
    DOMAIN = "domain"
    PROCESS = "process"
    TOOL = "tool"
    LANGUAGE = "language"
    PLATFORM = "platform"
    CONCEPT = "concept"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class KeywordPolicy:
    keyword: str
    kind: KeywordKind
    allow_bullet_rewrite: bool
    allow_summary: bool
    requires_same_bullet_evidence: bool = False
    requires_process_evidence: bool = False
    allow_tool_substitution: bool = False
    min_confidence: float = 0.70
    reasons: tuple[str, ...] = field(default_factory=tuple)
```

Policy behavior:
- `ROLE_TITLE`: `allow_bullet_rewrite=False`, `allow_summary=True`.
- `EDUCATION`: `allow_bullet_rewrite=False`, `allow_summary=True` only when resume education/background supports it.
- `DOMAIN`: `allow_bullet_rewrite=True` only with same-bullet domain evidence, `allow_summary=True` only with candidate-context domain evidence.
- `PROCESS`: `allow_bullet_rewrite=True` only with process evidence in the original bullet, `allow_summary=True` only with retained bullet or skills evidence.
- `TOOL`, `LANGUAGE`, `PLATFORM`: `allow_bullet_rewrite=True`, substitution allowed only when evidence is same category and no conflict.
- `UNKNOWN`: default conservative behavior, summary only if literal candidate context supports it.

### Evidence Model

Add helpers in `keyword_policy.py`:

```python
def classify_keyword_policy(keyword: str, *, job_title: str = "") -> KeywordPolicy:
    ...


def keyword_has_candidate_support(keyword: str, candidate_context: str) -> bool:
    ...


def keyword_has_same_bullet_support(keyword: str, original_bullet: str) -> bool:
    ...


def tool_substitution_allowed(keyword: str, original_bullet: str, resume_context: str) -> tuple[bool, list[str]]:
    ...
```

Evidence rules:
- Direct evidence: exact keyword appears in the original bullet.
- Related evidence: same category appears in the original bullet or resume context.
- Conflict evidence: original bullet has a concrete vendor/resource that conflicts with the requested keyword.
- Same-category examples:
  - `Azure DevOps` can map to CI/CD evidence such as Bitbucket Pipelines, GitHub Actions, Jenkins, GitLab CI, CircleCI, or build/release pipelines.
  - `React` can map to Next.js only if rendered as visible related-tech phrasing such as `React/Next.js`.
  - `cloud infrastructure` can map to AWS, Azure, GCP, Vercel, Supabase, Kubernetes, Docker deployment, or cloud architecture.
- Direct-only examples:
  - `Infrastructure as Code`: Terraform, CDK, Pulumi, CloudFormation, IaC, or infrastructure-as-code.
  - Security domains: real-time threat intelligence, XDR, MDR, ITDR, SIEM.
  - Domain terms such as robotics, welding, geometrical planning, or manufacturing automation require direct evidence in the bullet to enter a bullet.

### Pipeline Flow Change

Modify `fletcher/ad_hoc_pipeline.py`.

Current flow:
```text
missing keywords -> RAG -> high keywords -> rewrite
```

New flow:
```text
missing keywords
  -> keyword_policy_partition
       rewrite_candidates
       summary_candidates
       blocked_keywords
  -> RAG only on rewrite_candidates
  -> rewrite only if policy allows bullet rewrite for that bullet
  -> rejected or skipped rewrite keywords go through summary policy
  -> summary gets only supported summary keywords
```

New log step:
```text
keyword_policy_partition
  rewrite_candidates
  summary_candidates
  blocked_keywords
  policies
```

This prevents `Computer Engineering`, `Software Development Intern`, `Mathematics`, and similar non-bullet terms from ever reaching RAG bullet matching.

### Rewrite Prompt Change

Modify `rewrite_bullet_targeted()` in `fletcher/llm/llm_enrich.py`.

Add policy guidance to the prompt:

```text
Only use a keyword when you are at least 70 percent confident it truthfully belongs in this bullet.
If confidence is below 0.70, put the keyword in keywords_skipped.
For same-category tool substitution, the rewritten bullet must remain coherent with the original tools and vendors.
Do not mix conflicting cloud vendors, products, resources, or domains in one bullet.
If the requested tool is similar but not directly used, prefer truthful adjacent phrasing or keep the original tool visible.
```

New return schema:

```json
{
  "bullet": "...",
  "keywords_used": ["..."],
  "keywords_skipped": ["..."],
  "keyword_confidence": {"keyword": 0.0}
}
```

Validation rule:
- If any claimed used keyword has confidence below `0.70`, reject the rewrite for that keyword.
- If the response omits confidence for a claimed keyword, treat confidence as `0.0`.

### Tool Substitution Validation

Modify `validate_rewrite_grounding()` and add tests.

Rules:
- Direct exact tool in original bullet: allow direct wording.
- Similar same-category tool in original bullet: allow substitution only if the rewritten bullet remains coherent.
- Same ecosystem elsewhere in resume context: allow cautiously, but reject if the bullet itself has a vendor/resource conflict.
- Vendor conflict: reject.
- Resource conflict: reject.

Examples:

```python
assert reject(
    original="Reduced AWS S3 storage costs by optimizing lifecycle policies.",
    rewritten="Reduced Azure cloud storage costs by optimizing AWS S3 lifecycle policies.",
    keyword="Azure",
)
```

```python
assert allow_or_retry_truthfully(
    original="Automated CI/CD via Bitbucket pipelines and ECR/Kubernetes.",
    keyword="Azure DevOps",
)
```

The desired rewrite style for the second example should keep the CI/CD fact coherent, such as:

```text
Accelerated deployment cycles by automating CI/CD workflows comparable to Azure DevOps pipelines using Bitbucket Pipelines and ECR/Kubernetes.
```

This gives ATS signal without falsely saying the candidate directly used Azure DevOps in that bullet.

### Process Term Validation

Add process evidence checks:
- `unit testing`: original bullet must mention tests, testing, pytest, Jest, CI test runs, QA, or validation.
- `code reviews`: original bullet must mention review, PR, merge request, feedback, grading code, or peer review.
- `scrum`: original bullet must mention Scrum, sprint, standup, backlog, agile, or Scrum Master.
- `source repository processes`: original bullet must mention Git, repository, branch, PR, merge, Bitbucket, GitHub, GitLab, or source control.
- `full life cycle development`: original bullet must mention at least two lifecycle stages such as design, implementation, testing, deployment, maintenance, production support.

If process evidence is missing, skip the keyword before the LLM rewrite call.

### Summary Context Improvement

Modify `_build_candidate_context()` in `fletcher/ad_hoc_pipeline.py`.

Add top retained bullet evidence after rewrites and before summary generation:

```text
Relevant evidence:
- bullet 1
- bullet 2
- bullet 3
- bullet 4
- bullet 5
```

Select evidence by current RAG/drop relevance scores, top 3 to 5 bullets. This gives the summary generator actual facts, not just titles and skills.

Summary keyword policy:
- Role title: allowed for targeting.
- Education terms: allowed only if resume education supports the exact or safely broader term.
- Process terms: allowed only if retained bullets support them.
- Tool substitutions: summary can mention adjacent workflows if supported, but should not claim direct use of a tool unless exact tool appears in resume context.
- Domain terms: allowed only with candidate-context evidence.

### Title and Level Robustness

Modify `fletcher/jobs/title_inference.py`:
- Keep metadata-prefix rejection.
- Expand accepted title nouns beyond current software-only list: scientist, researcher, tester, writer, administrator, coordinator, owner, lead, technician, assistant, associate, operator.
- Reject metadata lines by shape as well as prefix: lines with salary, location labels, req IDs, job segment lists, or colon-heavy metadata.
- Add tests for `Data Scientist`, `QA Tester`, `Technical Writer`, `Product Owner`, and `Research Assistant`.

Modify `fletcher/jobs/classifier.py`:
- Replace first-match level detection with scored evidence.
- Title evidence gets highest weight.
- `currently pursuing` counts as intern only near student/degree/enrolled/pursuing degree wording.
- `senior software developers` as coworkers should not make the role senior.
- Explicit `few years`, `moderate guidance`, and `own delivery` should produce mid.
- Explicit `Software Development Intern`, hourly intern, co-op, internship, or currently pursuing degree should produce intern.

### Log Formatting Plan

Modify `fletcher/pipeline_logger.py`.

Live stdout format:

```text
------ pipeline event=13 +19.113s delta=0.004s step=bullet_rewrite_start ------
bullet_id=...
keywords=['Azure DevOps']
original=...
```

LLM live stdout format:

```text
------ llm event=14 +26.314s delta=7.201s call=rewrite_bullet status=ok duration_ms=7207 ------
```

Saved `pipeline_log.txt` format:

```text
------
[STEP +19.113s | delta=0.004s | event_id=13] bullet_rewrite_start
  bullet_id: ...
  keywords: ...

------
[LLM  +26.314s | delta=7.201s | event_id=14] rewrite_bullet success=True duration_ms=7207
  --- PROMPT ---
  ...
  --- RESPONSE ---
  ...
```

Implementation details:
- Use `ts:.3f` instead of `ts:.2f`.
- Store `delta` on each `_LogEntry`: time since previous logged event.
- Add separators before every event in live logs and saved logs.
- Keep `event_id` monotonic.
- Add `compile_duration_ms` by timing `_compile_doc()` inside `_fit_to_page()`.
- Add `phase` or `attempt` fields for retry logs, especially `bullet_rewrite_retry_done`, `summary_retry_start`, and `summary_retry_done`.

### Tests to Add

Create `tests/test_keyword_policy.py`:

```python
from fletcher.jobs.keyword_policy import KeywordKind, classify_keyword_policy


def test_job_title_not_bullet_rewrite():
    policy = classify_keyword_policy("Software Development Intern", job_title="Software Development Intern")
    assert policy.kind == KeywordKind.ROLE_TITLE
    assert policy.allow_bullet_rewrite is False


def test_education_terms_not_bullet_rewrite():
    for keyword in ["Computer Engineering", "Mathematics", "Computer Science"]:
        policy = classify_keyword_policy(keyword)
        assert policy.kind == KeywordKind.EDUCATION
        assert policy.allow_bullet_rewrite is False


def test_domain_terms_require_same_bullet_evidence():
    policy = classify_keyword_policy("robotics")
    assert policy.kind == KeywordKind.DOMAIN
    assert policy.requires_same_bullet_evidence is True


def test_tool_substitution_policy_allows_ci_tools():
    policy = classify_keyword_policy("Azure DevOps")
    assert policy.kind == KeywordKind.TOOL
    assert policy.allow_tool_substitution is True
```

Update `tests/test_rewrite_validation.py`:

```python
def test_low_confidence_keyword_is_rejected(monkeypatch):
    ...


def test_rejects_cross_vendor_cloud_conflict():
    ...


def test_allows_ci_cd_adjacent_tool_wording():
    ...


def test_process_keyword_requires_process_evidence():
    ...
```

Update `tests/test_ad_hoc_pipeline.py`:

```python
def test_policy_blocks_education_terms_before_rag(base_mocks):
    ...


def test_summary_context_includes_top_retained_bullet_evidence(base_mocks):
    ...
```

Update `tests/test_llm_enrich_logger.py`:

```python
def test_logger_uses_three_decimal_timestamps_and_separators():
    logger = PipelineLogger()
    logger.step("a")
    text = logger.get_log_text()
    assert "------" in text
    assert "+0." in text
    assert "delta=" in text
```

Update `tests/test_title_inference.py` and classifier tests:

```python
def test_title_inference_accepts_broader_titles():
    ...


def test_currently_pursuing_compliance_is_not_intern():
    ...
```

### Implementation Order

Task 1: Add keyword policy module and tests.
- Files: create `fletcher/jobs/keyword_policy.py`, create `tests/test_keyword_policy.py`.
- Run: `.\.venv\Scripts\python.exe -m pytest tests\test_keyword_policy.py -q`.

Task 2: Route pipeline through keyword policy before RAG.
- Files: modify `fletcher/ad_hoc_pipeline.py`, update `tests/test_ad_hoc_pipeline.py`.
- Run: `.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_pipeline.py tests\test_keyword_policy.py -q`.

Task 3: Add tool/process/domain validation and confidence.
- Files: modify `fletcher/llm/llm_enrich.py`, update `tests/test_rewrite_validation.py`.
- Run: `.\.venv\Scripts\python.exe -m pytest tests\test_rewrite_validation.py tests\test_llm_enrich_logger.py -q`.

Task 4: Improve summary evidence and summary keyword policy.
- Files: modify `fletcher/ad_hoc_pipeline.py`, update `tests/test_ad_hoc_pipeline.py`.
- Run: `.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_pipeline.py tests\test_rewrite_validation.py -q`.

Task 5: Broaden title inference and score job level.
- Files: modify `fletcher/jobs/title_inference.py`, `fletcher/jobs/classifier.py`, update title/classifier tests.
- Run: `.\.venv\Scripts\python.exe -m pytest tests\test_title_inference.py tests\test_component2_stage1.py -q`.

Task 6: Improve log readability.
- Files: modify `fletcher/pipeline_logger.py`, update logger tests and any affected snapshots/assertions.
- Run: `.\.venv\Scripts\python.exe -m pytest tests\test_llm_enrich_logger.py tests\test_ad_hoc_pipeline.py -q`.

Task 7: Final verification.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_keyword_policy.py tests\test_title_inference.py tests\test_rewrite_validation.py tests\test_ad_hoc_pipeline.py tests\test_component2_stage1.py tests\test_llm_enrich_logger.py tests\test_rag_drop_scoring.py -q
.\.venv\Scripts\python.exe ci.py c2
.\.venv\Scripts\python.exe quality.py shared
```

### Manual Smoke Expectations

Sophos JD:
- Title: `Software Engineer`.
- Level: `mid`.
- Bad domain rewrites remain rejected.
- `cloud infrastructure` can be kept from Vercel/Supabase.
- `Infrastructure as Code` remains rejected unless Terraform/IaC evidence exists.
- `React` should appear only as visible `React/Next.js` or summary-supported wording.
- Summary uses supported backend/testing/React terms, not XDR/MDR/SIEM unless resume evidence exists.

Lincoln Electric JD:
- Title: `Software Development Intern`.
- Level: `intern`.
- `Computer Engineering`, `Mathematics`, and role title keywords do not reach bullet rewrite.
- `Azure DevOps` only reaches rewrite if policy sees CI/CD evidence and no vendor conflict.
- `code reviews` does not enter a grading automation bullet unless review evidence exists.
- `multi-threaded parallel processing`, `robotics`, `WPF`, and `3D graphics` do not enter unrelated bullets.
- Runtime drops because obvious blocked keywords skip LLM rewrite attempts.

### Execution Handoff

Preferred execution path: use `executing-plans` in this same repo because files are tightly coupled and tests are local.

Alternative execution path: use `subagent-driven-development` only if splitting into independent slices:
- Agent 1: keyword policy and pipeline routing.
- Agent 2: rewrite validator and confidence.
- Agent 3: logging format and tests.

### Task 5A: Filter Summary Keywords Before Prompting

Files: Modify `fletcher/ad_hoc_pipeline.py`, `fletcher/llm/llm_enrich.py`, `tests/test_ad_hoc_pipeline.py`.

Observed issue: skipped rewrite keywords are currently appended to medium summary keywords wholesale. This can make the summary prompt ask for unsupported or tone-warping terms such as `XDR`, `real-time threat intelligence`, `AI-driven platform`, or `Infrastructure as Code`, even when those terms were rejected from bullet rewrites for lack of support.

Desired behavior:
- Summary should prioritize medium-tier keywords from RAG.
- Summary may include skipped rewrite keywords only if they are technologies/capabilities supported by candidate context.
- Unsupported domain/security terms should be excluded from summary rather than forced.
- The summary should include as many sensible medium keywords as possible, not every keyword.

Keyword selection rules:
- Always eligible: medium keywords that are generic role/process terms such as `Software Engineer`, `unit`, `integration`, `end-to-end`, `backend services`, `API`.
- Conditionally eligible: technologies present in candidate context, skills, or bullets such as `React`, `Terraform`, `cloud infrastructure` when supported by Vercel/Supabase/AWS/Kubernetes/Terraform context.
- Not eligible without direct candidate support: `XDR`, `MDR`, `ITDR`, `SIEM`, `real-time threat intelligence`, `AI-driven platform`.
- If a skipped keyword was rejected specifically for unsupported domain evidence, do not add it to summary.

- [ ] Step 1: Add failing test.

```python
def test_summary_keywords_filter_unsupported_domain_terms(base_mocks):
    from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline

    base_mocks.match_keywords_to_bullets.return_value = {
        "bullet_matches": [
            {"bullet_idx": 1, "keyword": "real-time threat intelligence", "score": 0.9},
            {"bullet_idx": 2, "keyword": "AI-driven platform", "score": 0.9},
        ],
        "summary_keywords": ["Software Engineer", "unit", "integration", "end-to-end", "backend services"],
        "ignored_keywords": [],
        "scores": [],
        "rag_used": True,
    }
    base_mocks.rewrite_bullet_targeted.return_value = {
        "bullet": "original",
        "success": False,
        "error": "rewrite_validation_failed",
        "duration_ms": 1,
        "keywords_used": [],
        "keywords_skipped": ["real-time threat intelligence", "AI-driven platform"],
        "validation": {
            "accepted": False,
            "reasons": [
                "unsupported_domain_keyword:real-time threat intelligence",
                "unsupported_domain_keyword:AI-driven platform",
            ],
        },
    }
    base_mocks.generate_summary.return_value = {"summary": "Summary text.", "success": True}

    run_ad_hoc_pipeline(title="Software Engineer", description="job")

    summary_keywords = base_mocks.generate_summary.call_args.args[2]
    assert "Software Engineer" in summary_keywords
    assert "unit" in summary_keywords
    assert "integration" in summary_keywords
    assert "real-time threat intelligence" not in summary_keywords
    assert "AI-driven platform" not in summary_keywords
```

- [ ] Step 2: Implement summary keyword filter.

Suggested helper in `ad_hoc_pipeline.py`:

```python
SUMMARY_BLOCKED_DOMAIN_KEYWORDS = {
    "real-time threat intelligence",
    "threat intelligence",
    "xdr",
    "mdr",
    "itdr",
    "siem",
    "ai-driven platform",
}

SUMMARY_GENERIC_KEYWORDS = {
    "software engineer",
    "unit",
    "integration",
    "end-to-end",
    "backend services",
    "api",
}

def _summary_keyword_supported(keyword: str, candidate_context: str, validation_reasons: list[str]) -> bool:
    key = keyword.lower()
    if any(reason.endswith(f":{keyword}") for reason in validation_reasons):
        return False
    if key in SUMMARY_BLOCKED_DOMAIN_KEYWORDS:
        return key in candidate_context.lower()
    if key in SUMMARY_GENERIC_KEYWORDS:
        return True
    if key == "cloud infrastructure":
        context_l = candidate_context.lower()
        return any(term in context_l for term in ("aws", "azure", "gcp", "vercel", "supabase", "kubernetes", "terraform"))
    return key in candidate_context.lower()
```

In `_run_iteration()`:
- Track validation rejection reasons from rewrite results.
- Build `candidate_context` before final `mid_keywords`.
- Use:

```python
summary_keywords = _dedupe(list(kw_match.get("summary_keywords", [])))
summary_keywords.extend(
    kw for kw in skipped_to_summary
    if _summary_keyword_supported(kw, candidate_context, validation_reasons)
)
mid_keywords = _dedupe(summary_keywords)[:8]
```

- [ ] Step 3: Tighten summary prompt.

Update `generate_summary()`:

```python
f"Use the keywords only when they fit the candidate background naturally. "
f"Do not try to include every keyword. Prioritize accurate, supported technologies and role/process terms. "
```

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_ad_hoc_pipeline.py tests/test_llm_enrich_logger.py -q
```

### Task 6: Optional LLM Job Title Fallback

Files: Modify `fletcher/jobs/title_inference.py`, `fletcher/ad_hoc_pipeline.py`, `tests/test_title_inference.py`.

- [ ] Step 1: Keep deterministic inference as default.

- [ ] Step 2: Add optional function, not used unless deterministic returns empty and backend is Ollama.

```python
def infer_title_with_ollama(description: str, chat_func) -> str:
    prompt = (
        "Extract the job title from this job description. Ignore company boilerplate headings. "
        "Return only: {\"job_title\": \"...\"}\n"
        f"Job description:\n{description[:4000]}"
    )
    parsed = json.loads(chat_func(prompt))
    return normalize_title_candidate(parsed.get("job_title") or "")
```

- [ ] Step 3: Wire into `_resolve_job_title()` only when deterministic title is empty.

This should be lowest priority because Sophos is fixed already.

### Task 7: Optional Auto-Repair for Redundant Backend Services

Files: Modify `fletcher/llm/llm_enrich.py`, `tests/test_rewrite_validation.py`.

- [ ] Step 1: Add test.

```python
def test_auto_repairs_microservices_backend_services_redundancy():
    repaired = repair_rewrite_redundancy(
        "Enhanced targeting by developing Kotlin microservices and backend services that integrated APIs."
    )
    assert "microservices and backend services" not in repaired
    assert "backend Kotlin microservices" in repaired
```

- [ ] Step 2: Implement small deterministic repair.

```python
def repair_rewrite_redundancy(text: str) -> str:
    return re.sub(r"Kotlin microservices and backend services", "backend Kotlin microservices", text)
```

- [ ] Step 3: Apply before validation.

This is lower priority than correct keyword accounting and summary validation.

### Final Verification

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_title_inference.py tests/test_rewrite_validation.py tests/test_ad_hoc_pipeline.py tests/test_component2_stage1.py tests/test_llm_enrich_logger.py tests/test_rag_drop_scoring.py -q
.\.venv\Scripts\python.exe ci.py c2
.\.venv\Scripts\python.exe quality.py shared
```

Manual Sophos smoke expectations:
- `React` no longer disappears when paired with rejected `AI-driven platform`.
- Summary avoids `motivated`, `eager`, and unsupported direct domain claims.
- Bad domain rewrites remain rejected.
- No-summary and with-summary PDFs still fit.

## Implemented Checkpoint: Action Phrase Validation and Summary Evidence

Implemented:
- Claimed keyword validation now accepts visible action inflections, for example `Monitor data pipelines` can match `monitoring data pipelines`.
- Claimed keyword validation still rejects scattered terms that do not keep the action and object together.
- Rewrite and validation prompts now tell the model that Datadog monitoring is acceptable only when the monitored object is explicit.
- Claimed-keyword failures can now trigger one narrow retry on a visibly present proper subset.
- Data-domain keywords now require direct original-bullet evidence and cannot be inferred from generic full-stack architecture.
- Summary generation now receives top retained bullet evidence in addition to titles and skills.
- Pipeline logs now include `------` separators, three-decimal timestamps, and per-event delta timing.

Still pending:
- Full pre-RAG keyword policy routing in `fletcher/jobs/keyword_policy.py`.
- Tool/process/domain support checks before rewrite calls.
- Summary regeneration or revalidation if the drop loop later removes evidence used by the summary.

### Task 8: Improve Timing and Log Clarity

Files: Modify `fletcher/pipeline_logger.py`, `fletcher/ad_hoc_pipeline.py`, `fletcher/llm/llm_enrich.py`, tests as needed.

Observed issue: many log lines show the same elapsed timestamp. Some are legitimate because they happen back-to-back after one LLM call returns, but the logs do not make that obvious. It is hard to tell whether events happened instantly, reused a timestamp, or were grouped after a blocking call.

Desired logging improvements:
- Add monotonically increasing `event_id` to every pipeline log step and LLM log.
- Include per-step `duration_ms` where a step has real work.
- For LLM calls, log `start` and `done` or include both `started_at_ms` and `duration_ms`.
- For grouped post-processing steps, optionally include `parent_event_id` or `after_event`.
- Keep existing human-readable `[pipeline +X.XXs]` format, but add structured fields so equal timestamps are less confusing.

- [ ] Step 1: Add a test for event IDs.

```python
from fletcher.pipeline_logger import PipelineLogger


def test_pipeline_logger_event_ids_are_monotonic():
    logger = PipelineLogger()
    logger.step("a")
    logger.step("b")
    text = logger.get_log_text()
    assert "event_id: 1" in text
    assert "event_id: 2" in text
```

- [ ] Step 2: Update `PipelineLogger`.

Implementation shape:

```python
class PipelineLogger:
    def __init__(self):
        self._event_id = 0

    def _next_event_id(self) -> int:
        self._event_id += 1
        return self._event_id

    def step(self, name: str, **fields):
        fields = {"event_id": self._next_event_id(), **fields}
        ...
```

- [ ] Step 3: Add clearer timing fields around blocking calls.

Examples:
- `llm_keyword_extract_start` with `event_id`
- `keywords_extracted` with `duration_ms`
- `bullet_rewrite_start` / `bullet_rewrite_done` already exist, ensure `duration_ms` is always present.
- `validate_rewrite` logs should include `duration_ms`.
- `compile_start` / `compile_done` should include `duration_ms` if easy to calculate.

- [ ] Step 4: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_llm_enrich_logger.py tests/test_ad_hoc_pipeline.py -q
```

## Implemented Checkpoint: Policy Router Fail-Closed Fix

Observed issue:
- In deployed Docker runs, the LLM keyword policy router can return `None`.
- `_partition_missing_keywords_by_policy()` assumed the router always returned a dict and crashed with `AttributeError: 'NoneType' object has no attribute 'get'`.
- This produced a 500 after keyword partitioning, before RAG and resume generation.

Implemented:
- Treat non-dict or `None` router responses as an empty route map.
- Continue with deterministic policy routing when the LLM router is unavailable.
- Log `keyword_policy_llm_unavailable` or `keyword_policy_llm_invalid` so the fallback is visible in pipeline logs.
- Added regression coverage for `classify_keyword_routes_with_ollama()` returning `None`.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_pipeline.py::test_llm_policy_router_none_does_not_crash -q`
- `.\.venv\Scripts\python.exe -m pytest tests\test_keyword_policy.py tests\test_ad_hoc_pipeline.py tests\test_rewrite_validation.py tests\test_llm_enrich_logger.py -q`
- `.\.venv\Scripts\python.exe ci.py c2`

## Implemented Checkpoint: LLM Default Routing and End-of-Log Digest

Observed issue:
- Slash-combo keywords such as `Java/Kotlin`, `Docker/Kubernetes`, and `Spring Boot/Spring Cloud` stayed bundled, which made policy, RAG, summary, and skills routing less precise.
- The keyword policy router was intended to rescue ambiguous PM/data/process terms but was still a stub, so SAP-style terms such as `project coordination` and `project metrics` fell back to deterministic `ignore:unknown`.
- Logs required manual reconstruction to answer basic questions about found keywords, RAG levels, rewrite before/after, summary keywords, and dropped bullets.
- LLM summary validation could accept banned junior tone such as `Eager to apply`.

Implemented:
- Split slash-combo tech keywords before present/missing partition and before Technical Skills bucketing.
- Preserve known slash phrases that should not split, including `A/B testing`, `CI/CD`, and `PL/SQL`.
- Implemented `classify_keyword_routes_with_ollama()` so non-blocked missing keywords are routed by LLM by default.
- Kept deterministic guardrails for obvious hard blocks such as empty terms, logistics, org metadata, and unsupported language requirements.
- Prevented role-title and education terms from being upgraded to bullet rewrite even if the LLM suggests rewrite.
- Added `pipeline_debug_summary` near the end of the log with keywords found, keyword partition, policy routes, RAG high/medium/low, successful bullet rewrites with before/after, summary keywords, dropped bullets, rewrite counts, and summary line checks.
- Added deterministic summary grounding as a final defense after LLM summary validation so banned tone still triggers retry.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_llm_enrich_logger.py tests\test_ad_hoc_pipeline.py tests\test_keyword_policy.py tests\test_rewrite_validation.py -q`
- `.\.venv\Scripts\python.exe ci.py c2`

## Implemented Checkpoint: Readable Pipeline Debug Summary

Observed issue:
- `pipeline_debug_summary` contained the right information but rendered as one large dict line.
- It was hard to visually scan keyword levels, rewrites, summary keywords, and dropped bullets.

Implemented:
- Added special rendering in `PipelineLogger.get_log_text()` for `pipeline_debug_summary`.
- The final digest now prints separated sections:
  - `Keywords Found`
  - `Keyword Partition`
  - `Policy Routes`
  - `RAG Levels`
  - `Bullet Rewrites`
  - `Summary Keywords`
  - `Dropped Bullets`
  - `Rewrite Attempts`
  - `Summary Line Checks`
- Preserved the structured step name and event ID so existing log search still works.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_pipeline.py tests\test_llm_enrich_logger.py -q`
- `.\.venv\Scripts\python.exe ci.py c2`

## Implemented Checkpoint: Prompt-Led Safety and Signal Quality Fixes

Observed issue:
- Some unrelated postings, such as executive/chief roles, can still pass through if the LLM job-fit call does not set `mismatch=true`.
- Technical Skills bucketing needs clearer instructions so the model ignores soft phrases such as `analytical thinking` or vague terms such as `product databases`.
- Invalid JSON from the keyword policy router produced two confusing LLM log entries: one success and one failure.
- Summary generation and validation need to prefer no summary over a polished but unsupported one.

Implemented:
- Strengthened the LLM job-fit prompt so executive, chief, VP, head, C-level, and unsupported out-of-lane postings are marked as mismatches by model judgment.
- Removed the fixed terminology mismatch override. Job mismatch is now driven by the LLM job-fit result, not a tiny hardcoded vocabulary.
- Strengthened the Technical Skills bucketing prompt: only canonical named skills should be returned, and uncertain terms must go to `ignored`.
- Removed the fixed Skills allowlist so future technologies are not blocked just because they are absent from a local list.
- Changed keyword router logging so parse failures produce a single failed `keyword_policy_route` LLM event instead of an ok event followed by a failed event.
- Strengthened summary generation and validation prompts so unsupported summaries are rejected or omitted rather than patched by fixed terminology checks.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_pipeline.py::test_llm_job_fit_mismatch_aborts_without_fixed_role_terms tests\test_ad_hoc_pipeline.py::test_skill_bucket_trusts_llm_bucket_output_without_fixed_allowlist tests\test_llm_enrich_logger.py::test_summary_validation_prompt_requires_rejecting_unsupported_claims tests\test_llm_enrich_logger.py::test_skill_bucket_prompt_requires_canonical_named_skills -q`: 4 passed.
- `.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_pipeline.py tests\test_llm_enrich_logger.py tests\test_keyword_policy.py tests\test_rewrite_validation.py -q`: 96 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.

## Implemented Checkpoint: LLM Signal Routing and Skill Evidence Validation

Observed issue:
- The keyword extractor could spend its first 20 terms on generic responsibilities, job titles, education fields, or soft traits instead of concrete stack and workflow signals.
- A large or malformed policy-router response could cause all terms in a role-heavy JD to fall back to `ignore:unknown`.
- Summary filtering and Technical Skills bucketing could accept malformed model output, off-list terms, or vague concepts.
- Technical Skills additions needed to stay future-proof without returning to a fixed local allowlist.

Implemented:
- Strengthened keyword extraction to request resume-relevant signals in priority order: concrete stack terms first, concrete technical methods and workflows second, and concrete quality or process traits third.
- Told keyword extraction to skip job titles, employment types, program names, departments, logistics, credentials, education fields, compensation, executive visibility, generic deliverables, and vague nouns unless paired with concrete tools or methods.
- Batched LLM keyword policy routing in small groups and retried failed multi-keyword batches as single-keyword calls before using deterministic fallback.
- Strengthened policy routing instructions so non-tech stack or unsupported personality traits should not become bullet rewrite targets unless the model is at least 70 percent comfortable.
- Added one retry for summary keyword filtering when the model returns terms outside the candidate keyword list.
- Added one retry for Technical Skills bucketing when required keys are missing or the model returns terms outside the input list.
- Added LLM evidence validation before adding any generated keyword to the bottom Technical Skills section. Accepted skills must be canonical named skills supported by resume evidence, existing skills, or close named equivalents.
- Strengthened summary validation to judge support sentence by sentence, so one unsupported sentence can reject the whole summary.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_llm_enrich_logger.py::test_keyword_extract_prompt_prioritizes_stack_and_skips_noise tests\test_llm_enrich_logger.py::test_summary_filter_retries_unrequested_terms tests\test_llm_enrich_logger.py::test_skill_bucket_retries_missing_required_keys tests\test_llm_enrich_logger.py::test_skill_validation_rejects_concepts_not_named_skills tests\test_llm_enrich_logger.py::test_summary_validation_prompt_requires_rejecting_unsupported_claims tests\test_ad_hoc_pipeline.py::test_policy_router_batches_non_blocked_missing_keywords tests\test_ad_hoc_pipeline.py::test_policy_router_retries_failed_batch_as_singletons tests\test_ad_hoc_pipeline.py::test_skill_bucket_requires_llm_validation -q`: 8 passed.
- `.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_pipeline.py tests\test_llm_enrich_logger.py tests\test_keyword_policy.py tests\test_rewrite_validation.py -q`: 102 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.

## Implemented Checkpoint: Deployed Log Follow-Up Fixes

Observed issue:
- A correctly detected `JobMismatchError` returned HTTP 500 from `/api/fletcher/tailor`, making an expected safety skip look like a backend crash.
- The live Docker logs still printed `pipeline_debug_summary` as one giant inline dict, even though downloaded logs were readable.
- Soft quality/personality terms such as `communication` could still be upgraded to bullet rewrite by LLM routing or deterministic fallback.
- A successful repaired rewrite could still log the initial failed validation under `validation`, making logs appear contradictory.
- The rewrite validator was too willing to accept security vulnerability wording from generic bug detection or app monitoring evidence.

Implemented:
- `/api/fletcher/tailor` now returns structured JSON for `JobMismatchError`, including the pipeline log, instead of raising HTTP 500.
- Fletcher UI now displays `errorType` and `error` as a visible banner and still exposes the log download when no resume is generated.
- `PipelineLogger.step()` now renders `pipeline_debug_summary` as readable sections in live stdout, not only in downloaded logs.
- Quality terms are downgraded to summary-only before RAG/bullet rewrite, even if the router suggests `rewrite`.
- Repaired rewrite success now replaces `validation` with the successful repair validation and preserves the failed first pass as `initial_validation`.
- Rewrite validation prompt now requires direct security evidence for vulnerability/security-testing terms and rejects inferring them from generic bug/error monitoring.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_llm_enrich_logger.py::test_pipeline_logger_prints_debug_summary_readably tests\test_llm_enrich_logger.py::test_rewrite_repair_success_uses_repair_validation tests\test_ad_hoc_pipeline.py::test_quality_terms_do_not_route_to_bullet_rewrite -q`: 3 passed.
- `.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_pipeline.py tests\test_llm_enrich_logger.py tests\test_keyword_policy.py tests\test_rewrite_validation.py -q`: 105 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.

## Implemented Checkpoint: Computer Infrastructure Roles Are In Scope

Observed issue:
- A Network Engineer posting was marked as `mismatch=true` because the job-fit prompt described supported lanes too narrowly as software, data, PM, firmware, or closely related technical/product roles.
- The user clarified that computer-related roles should be acceptable, including network engineering and cloud infrastructure roles.

Implemented:
- Widened the `analyze_job_fit` prompt so computer-related roles are treated as supported when no requested title conflicts: software, data, PM, firmware, cloud infrastructure, network engineering, security engineering, DevOps, SRE, IT systems, platform, infrastructure, and closely related technical/product roles.
- Added `infrastructure` as an allowed LLM role family.
- Added infrastructure summary positioning for network/cloud/security/platform roles.
- Updated deterministic classification so `Network Engineer`, `Cloud Engineer`, `Infrastructure Engineer`, `Security Engineer`, `Systems Engineer`, DevOps, SRE, and platform engineering map to `infrastructure`.
- Kept mismatch behavior for truly non-computer roles and executive-only postings when the requested title does not ask for executive leadership.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_llm_enrich_logger.py::test_job_fit_prompt_treats_network_cloud_roles_as_supported tests\test_component2_stage1.py::Component2Stage1Tests::test_network_engineer_is_infrastructure_family -q`: 2 passed.
- `.\.venv\Scripts\python.exe -m pytest tests\test_component2_stage1.py tests\test_llm_enrich_logger.py tests\test_ad_hoc_pipeline.py tests\test_keyword_policy.py tests\test_rewrite_validation.py -q`: 114 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.

## Implemented Checkpoint: D Check and L Check Split

Observed issue:
- Some deterministic checks were making semantic decisions that should belong to the model.
- `end-to-end` was rejected as `unsupported_summary_domain:end-to-end`, even though it is a process phrase rather than a direct domain claim.
- `REST APIs` was treated as missing even when the resume already contained `RESTful APIs`, causing no-op rewrites.
- If LLM keyword routing omitted an unknown term, deterministic fallback could still erase useful PM/process signals as `ignore:unknown`.

Implemented:
- Kept d checks only for mechanical matching and hard safety: spelling variants, role-title and education rewrite blocks, quality rewrite downgrade, claimed-keyword visibility, and banned-tone summary guard.
- Removed deterministic summary domain support rejection. Summary truthfulness is now an l check through sentence-level summary validation. If the summary validation LLM is unavailable, the summary is omitted rather than accepted by a semantic d fallback.
- Improved keyword present/missing d check with lexical normalization for case, punctuation, hyphen/space, simple plural/gerund variants, and `RESTful API` versus `REST API`.
- Changed unknown keyword policy fallback so a missing LLM route sends non-hard-blocked unknown terms to summary, not rewrite or ignore.
- Changed summary keyword fallback so terms stay in the safer summary lane when the LLM filter is unavailable, then summary generation and validation decide support.
- Added a stricter Ollama system message and lowered temperature from `0.2` to `0.1`. Each Ollama call is still a fresh stateless chat request, so every prompt must remain self-contained.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_keyword_check.py tests\test_rewrite_validation.py tests\test_ad_hoc_pipeline.py tests\test_llm_enrich_logger.py -q`: 117 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.

## Implemented Checkpoint: Routing Is JD Filtering, RAG Owns Resume Fit

Observed issue:
- Keyword policy routing was using candidate resume context and making early fit judgments.
- This duplicated RAG's job and made routing too opinionated: the router could send keywords to rewrite because it saw approximate resume evidence, or skip terms before RAG had a chance to rank them.
- Rewrite validation was also too strict in the opposite direction, rejecting reasonable adjacent phrasing because the exact phrase was not directly stated in the original bullet.

Implemented:
- Keyword extraction now asks for 0 to 30 resume-tailoring keywords that appear in the JD and are intended for bullets, summary, or skills when later matching supports them.
- Keyword extraction instructions emphasize named tech stack, concrete technical workflows, and requested process/personality traits while excluding job titles, logistics, credentials, metadata, and vague deliverables.
- Keyword policy routing no longer includes candidate resume context in the prompt. It filters the JD keyword list only.
- Routing now acts as a pre-RAG cleanup layer: keep concrete tech/workflow terms for RAG, keep concrete traits for summary, and ignore non-actionable JD noise.
- Routing batch size is now 30, so normal 0 to 30 keyword outputs route in one LLM call. If that call fails, the existing singleton retry path still protects reliability.
- Rewrite and repair prompts now emphasize preserving Google XYZ-style bullet order, preserving meaning, avoiding incoherent technology relationships, and allowing reasonable adjacent framing when it stays in the same work context.
- Rewrite validation no longer asks for direct textual evidence by default. It accepts contextually coherent phrasing and rejects meaning changes, unrelated domains, invented responsibilities, changed outcomes, and incoherent technology/vendor/resource pairings.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_llm_enrich_logger.py tests\test_ad_hoc_pipeline.py tests\test_rewrite_validation.py tests\test_keyword_check.py -q`: 118 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.

## Implemented Checkpoint: Job Fit and Keyword Extraction Share One LLM Call

Observed issue:
- Option B still ran one LLM call for job-fit/title/classification and a second LLM call for JD keyword extraction.
- This made the pipeline slower and split one conceptual decision into two prompts.
- The intended flow is: fetch or infer job info, extract filtered resume-tailoring keywords in that same pass, then let RAG decide which kept terms fit the resume.

Implemented:
- `analyze_job_fit_with_ollama()` now returns title, role family, job level, mismatch status, JD usability, JD usability reason, and 0 to 30 filtered resume-tailoring keywords in one JSON response.
- The combined keyword instructions are shared with the fallback keyword-only prompt, so both paths ask for concrete tech stack, technical workflows, and explicitly requested process/personality traits while skipping job titles, logistics, credentials, metadata, and vague business noise.
- `run_ad_hoc_pipeline()` now reuses keywords from `analyze_job_fit` when that response includes `jd_usable`; it only calls the older `keyword_extract` path as a fallback for missing/older/invalid combined responses.
- Slash-combo tech splitting still happens before present/missing partition, so combined-call keywords like `.NET/Angular` become `.NET` and `Angular`.
- `keywords_extracted` logs now include `source=analyze_job_fit` or `source=keyword_extract` so it is obvious which path produced the terms.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_llm_enrich_logger.py tests\test_ad_hoc_pipeline.py tests\test_rewrite_validation.py tests\test_keyword_check.py -q`: 119 passed.

## Implemented Checkpoint: Keyword Flow Cleanup After Combined-Call Logs

Observed issue:
- The post-combined-call logs showed the new job-fit keyword extraction path working, but downstream keyword flow still had gaps.
- `skills_only` routed terms were visible in logs but were not being considered for the Technical Skills section.
- Present/missing detection checked bullets but not the existing bottom skills list, so already-listed skills could still be treated as missing.
- Phrases containing `CI/CD`, such as `CI/CD pipelines`, were split into `CI` and `CD pipelines`.
- If a rewrite claimed a keyword but did not visibly include it, the pipeline returned `claimed_keyword_missing` immediately instead of trying the one repair pass.
- Debug summary rendered `low_count` and `rag_used` under the Medium list and dropped bullets only showed IDs.

Implemented:
- Present/missing partition now checks both resume bullets and existing skills.
- `skills_only` keywords are now included in the final Technical Skills candidate pool. For the no-summary version, medium/skipped/skills-only terms can be skill candidates. For the summary version, unused medium/excluded/skills-only terms can be skill candidates after summary generation.
- Slash splitting now preserves phrases containing `CI/CD`.
- Claimed-keyword visibility failures now run one repair attempt, then the repaired text goes through the same visibility and LLM meaning checks.
- Bullet-drop logs now include dropped bullet text.
- Pipeline debug summary now separates `Low Count` and `RAG Used` from the Medium keyword list and prints dropped bullet text when available.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_pipeline.py::test_ci_cd_phrase_is_not_split tests\test_ad_hoc_pipeline.py::test_keyword_present_partition_includes_skills tests\test_ad_hoc_pipeline.py::test_skills_only_keywords_are_considered_for_skills tests\test_llm_enrich_logger.py::test_claimed_keyword_missing_gets_repair_attempt tests\test_llm_enrich_logger.py::test_pipeline_debug_summary_separates_rag_metadata -q`: 5 passed.
- `.\.venv\Scripts\python.exe -m pytest tests\test_llm_enrich_logger.py tests\test_ad_hoc_pipeline.py tests\test_rewrite_validation.py tests\test_keyword_check.py -q`: 124 passed.
- `.\.venv\Scripts\python.exe -m pytest tests\test_pipeline_logger.py tests\test_option_b_smoke.py -q`: 14 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.

## Implemented Checkpoint: Skill Cap, Summary Choice, and Queue Lane Block

Observed issue:
- Logs showed too many skill keywords added when several medium-tier terms were loosely plausible.
- The summary path could fail because the validator rejected a visible skill such as `Next.js`.
- Summary generation was being handed only the first few medium keywords instead of choosing from the full set.
- Obvious civil/CAD/transportation roles should be blocked in the structured queue workflow, but Option B ad-hoc should still process pasted jobs.
- Bullet staying power needs product design before code, because current Option B has no user mark/protect input.

Implemented:
- Skill keyword additions now rank candidates against existing Technical Skills with the same RAG scoring path and send only the top three to skill bucketing.
- Summary prompts now receive the full filtered medium-keyword list and are told to pick at most three based on coherent candidate positioning, not pure tech-stack matching.
- Summary validation now has a narrow visible-evidence override for obvious LLM validator false negatives while deterministic grounding still rejects banned tone or incoherent unsupported claims.
- Queue-based generation now records a failed `unsupported_target_role` attempt for obvious civil/CAD/transportation-style postings before generating a resume.
- Option B ad-hoc generation does not use the queue lane block.
- Bullet staying power remains design-only: future full Hunt workflow can support protected bullets, important bullets, and configurable order-based bonuses, but no drop-scoring behavior was changed yet.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_llm_enrich_logger.py tests\test_ad_hoc_pipeline.py tests\test_rewrite_validation.py tests\test_keyword_check.py tests\test_pipeline_logger.py tests\test_option_b_smoke.py tests\test_component2_pipeline.py -q`: 164 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.

## Option A Versus Option B Contract

Option A: queued or existing DB job workflow
- Runs by default from jobs already stored in the database, or for a specific existing job ID.
- Job metadata is expected to already be populated by earlier Hunt stages: title, company, description, apply metadata, enrichment status, and other structured fields.
- C2 should not re-fetch or re-infer every populated field. It should trust existing structured values unless a specific value is empty or unusable.
- If a needed field is empty, C2 may run the same LLM inference prompt used by Option B, but only to fill the missing value. It should not overwrite good existing DB values just because the model offers a new guess.
- Because Option A belongs to the full Hunt workflow, it can apply target-lane policy. If a job is clearly unrelated to the intended search lane, such as civil/CAD/transportation engineering for this software/data/product/infrastructure resume workflow, C2 should reject resume generation and mark the job or resume attempt with an irrelevant/unsupported status such as `unsupported_target_role`.
- Option A can later support richer workflow-specific inputs such as protected bullets, important bullets, user target lanes, and per-user resume strategy settings.

Option B: ad-hoc JD plus resume workflow
- Runs when the user directly provides a job description and resume input.
- The job description may be the only source of job information, so C2 has to infer or fetch the actual title, role family, job level, JD usability, and keywords from the pasted description.
- The combined job-fit/keyword LLM call is appropriate here because Option B does not have earlier Hunt stages supplying structured metadata.
- C2 should assume the provided JD and resume are intentional and accurate for the user's current request. It should still reject unusable or empty scrapes, but it should not apply the same target-lane rejection policy as Option A.
- Option B should remain flexible for experiments, one-off tailoring, and cases where the user deliberately wants to test a resume against an unusual role.

## Follow-Up Decisions: L Checks Own Cleanup

Observed issue:
- RAG-only skill ranking chose odd Technical Skills such as `dashboards`, `WaterCAD`, `AutoCAD`, `Android Studio`, or domain-specific tools because similarity alone cannot decide whether a keyword belongs in this candidate's skill section.
- The intended cap is max 2 keywords per rewritten bullet, not a global cap on all skill candidates.
- Keyword extraction and routing should not rely on deterministic cleanup for role labels, disciplines, IDE names, or vague deliverables.

Implemented direction:
- Remove the global top-3 RAG skill cap. Send all high/medium RAG-supported skill candidates to the skill-bucketing LLM.
- Strengthen the skill-bucketing LLM prompt so it can add nothing when candidates do not belong beside the existing skills.
- The skill-bucketing LLM should ignore standalone deliverables such as `dashboards`, but may keep specific technical compounds such as `AI-driven dashboard` or `Kanban dashboard`.
- The keyword extraction and routing LLM prompts should exclude IDE/editor/dev-environment names such as `Android Studio`, `Xcode`, `VS Code`, and `IntelliJ`.
- The post-extraction keyword router is the L-check that removes anything that is not tech stack, job-related technical terms/techniques/workflows, or explicitly requested personality/process traits.
- Rewrite prompts should emphasize that making the bullet coherent matters more than forcing keywords. It is always acceptable to skip a keyword that cannot fit cleanly.
- The shared job-fit prompt now returns `unsupported_target_role`. Option A may use that flag to block unrelated jobs; Option B logs it but ignores it for generation.

Verification:
- `.\.venv\Scripts\python.exe -m pytest tests\test_llm_enrich_logger.py tests\test_ad_hoc_pipeline.py tests\test_rewrite_validation.py tests\test_keyword_check.py tests\test_pipeline_logger.py tests\test_option_b_smoke.py tests\test_component2_pipeline.py -q`: 165 passed.
- `.\.venv\Scripts\python.exe ci.py c2`: passed.

## Implemented Checkpoint: RAG Is the Only Keyword Router

Observed issue:
- The combined job-fit LLM call was returning `keyword_routes`, and the pipeline had a second pre-RAG keyword policy router that split missing terms into rewrite, summary-only, skills-only, and ignored buckets.
- This duplicated the actual RAG high/medium/low tiering and made the pipeline harder to reason about.
- The desired contract is simpler: the first LLM extracts and filters clean resume-tailoring keywords only. RAG is the only routing step.

Implemented:
- Removed `keyword_routes` from the active combined job-fit prompt and result.
- Removed the old standalone keyword-route LLM helper from active code so there is no separate route-before-RAG path left.
- Strengthened the job-fit prompt to say not to route keywords and to remove non-keywords such as job titles, role labels, seniority labels, employment types, degrees, majors, education fields, certifications, licenses, credentials, locations, compensation, company metadata, IDE/editor/dev-environment names, standalone deliverables, vague nouns, and generic role words captured elsewhere.
- RAG high/medium/low is now the sole keyword routing system: high can become bullet rewrites, medium can feed summary and skills, low is ignored.
- Updated pipeline debug summaries and Option B smoke quality notes to remove Policy Routes.

Verification:
- `python -m compileall fletcher\llm\llm_enrich.py fletcher\ad_hoc_pipeline.py fletcher\pipeline_logger.py`: passed.
- `python -m pytest tests/test_ad_hoc_pipeline.py tests/test_llm_enrich_logger.py tests/test_rewrite_validation.py tests/test_component2_pipeline.py tests/test_option_b_smoke.py tests/test_pipeline_logger.py -q`: 149 passed.
- `python ci.py c2`: passed.

## Implemented Checkpoint: Removed Pre-RAG Cleanup Gate

Observed issue:
- Even after removing route decisions, `keyword_cleanup` was still a deterministic hardcoded gate that could remove job titles, degrees, metadata, and similar non-keywords after extraction.
- The preferred behavior is for keyword extraction itself to avoid returning those items.

Implemented:
- Removed the `keyword_cleanup` pipeline step completely.
- Removed `removed_keywords` from the combined job-fit prompt/result schema.
- Missing keywords now go directly to RAG after normal extraction/normalization and present/missing partitioning.
- The extraction prompt now carries the non-keyword exclusion rule: do not include job titles, role labels, seniority labels, employment types, degrees, majors, education fields, certifications, licenses, credentials, locations, compensation, company metadata, IDE/editor/dev-environment names, standalone deliverables, vague nouns, or generic role words.
- Pipeline debug summaries and smoke quality notes no longer include Keyword Cleanup.

Verification:
- `python -m pytest tests/test_ad_hoc_pipeline.py tests/test_llm_enrich_logger.py tests/test_rewrite_validation.py tests/test_component2_pipeline.py tests/test_option_b_smoke.py tests/test_pipeline_logger.py -q`: 147 passed.
- `python ci.py c2`: passed.

## Implemented Checkpoint: LLM-Only Rewrite Validation, Bullet Order Boost, and LLM Skill Selection

Observed issue:
- Rewrite validation still had deterministic claimed-keyword presence and grounding helpers around the LLM validator.
- Bullet drop scoring did not yet give any built-in staying power to earlier bullets inside the same job/project bucket.
- Skill addition still had a deterministic prefilter before the skill-bucketing LLM.

Implemented:
- Removed the active deterministic rewrite validation checks and deleted the old rewrite grounding/presence helper tests. Rewrites are now accepted or rejected by the LLM validator path.
- Added configurable bullet-order score multipliers. The first bullet in each bucket currently gets a `1.5` score multiplier, the last gets `1.0`, and bullets between them interpolate linearly. Bucket order itself is not used.
- Removed the deterministic skill-candidate prefilter. All RAG-supported summary/skill candidates are sent to the skill-bucketing LLM.
- Strengthened the skill-bucketing prompt to choose `0 to 3` additions and return JSON categories.
- Kept the deterministic post-LLM skill cap: if the LLM returns more than three additions, the pipeline keeps only the first three returned additions across all categories.
- Page-fit still runs after skill additions, so added skill lines can trigger the normal bullet-drop loop.

Verification:
- `python -m pytest tests/test_ad_hoc_pipeline.py tests/test_llm_enrich_logger.py tests/test_rewrite_validation.py tests/test_component2_pipeline.py tests/test_option_b_smoke.py tests/test_pipeline_logger.py -q`: 135 passed.
- `python ci.py c2`: passed.
