# C2 Option B Pipeline Rewrite Plan
> REQUIRED SUB-SKILL: superpowers:executing-plans or superpowers:subagent-driven-development

Goal: Rewrite Option B (ad-hoc JD+resume upload) flow to do clean keyword injection, logging, 3 downloads, and drag-drop.

Architecture: New `ad_hoc_pipeline.py` runs separate from queue pipeline. Keyword presence check gates RAG so we only inject missing terms. PipelineLogger captures every LLM call + step for download. Option A queue flow untouched.

Tech Stack: Python stdlib, pydantic, existing `llm_enrich.py` / `rag.py`, FastAPI, React + TypeScript.

---

## Scope

### What changes
- `fletcher/pipeline_logger.py` — NEW: structured log capture
- `fletcher/keyword_check.py` — NEW: keyword-in-bullet presence scan
- `fletcher/ad_hoc_pipeline.py` — NEW: clean Option B flow (no library/profile)
- `fletcher/pipeline.py` — round-robin trim replaces current trim; expose ad-hoc entry
- `fletcher/llm/llm_enrich.py` — logger param on all LLM fns; preserve-list on bullet rewrite
- `backend/app.py` — tailor endpoint returns 3 base64 blobs
- `frontend/src/api/control.ts` — TailorResult adds `log: Blob | null`
- `frontend/src/pages/Fletcher/index.tsx` — 3 downloads + drag-drop

### What does NOT change
- Option A queue flow (`generate_resume_for_job`, `generate_resumes_for_ready_jobs`)
- `generate_tailored_resume()` in `generator.py`
- RAG index build / `match_keywords_to_bullets()` signatures
- DB schema, storage layout, auth

---

## Task 1: PipelineLogger

Files: Create `fletcher/pipeline_logger.py`

```python
# fletcher/pipeline_logger.py
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class _LogEntry:
    ts: float
    kind: str          # "step" | "llm"
    name: str
    detail: dict


class PipelineLogger:
    def __init__(self) -> None:
        self._entries: list[_LogEntry] = []
        self._start = time.perf_counter()

    def step(self, name: str, **detail: Any) -> None:
        self._entries.append(_LogEntry(
            ts=time.perf_counter() - self._start,
            kind="step", name=name, detail=detail,
        ))

    def llm_call(
        self,
        name: str,
        prompt: str,
        response: str,
        duration_ms: int | None,
        success: bool = True,
        error: str | None = None,
    ) -> None:
        self._entries.append(_LogEntry(
            ts=time.perf_counter() - self._start,
            kind="llm", name=name,
            detail={
                "prompt": prompt,
                "response": response,
                "duration_ms": duration_ms,
                "success": success,
                "error": error,
            },
        ))

    def get_log_text(self) -> str:
        lines: list[str] = ["=" * 70, "PIPELINE LOG", "=" * 70, ""]
        for e in self._entries:
            ts = f"+{e.ts:.2f}s"
            if e.kind == "step":
                lines.append(f"[STEP  {ts}] {e.name}")
                for k, v in e.detail.items():
                    lines.append(f"  {k}: {v}")
                lines.append("")
            else:
                lines.append(f"[LLM   {ts}] {e.name}  success={e.detail['success']}  {e.detail['duration_ms']}ms")
                lines.append("  --- PROMPT ---")
                for ln in str(e.detail["prompt"]).splitlines():
                    lines.append(f"  {ln}")
                lines.append("  --- RESPONSE ---")
                for ln in str(e.detail["response"]).splitlines():
                    lines.append(f"  {ln}")
                if e.detail.get("error"):
                    lines.append(f"  ERROR: {e.detail['error']}")
                lines.append("")
        return "\n".join(lines)
```

- [ ] Create file with code above
- [ ] `cd hunt && .venv/Scripts/python.exe -c "from fletcher.pipeline_logger import PipelineLogger; l = PipelineLogger(); l.step('test', x=1); l.llm_call('kw', 'prompt', 'resp', 100); print(l.get_log_text())"` → expect structured log printed, no errors
- [ ] Commit: `git add fletcher/pipeline_logger.py && git commit -m "add PipelineLogger"`

---

## Task 2: Keyword Presence Check

Files: Create `fletcher/keyword_check.py`

Purpose: given extracted keywords + all bullets in the resume, split into already-present vs missing.

```python
# fletcher/keyword_check.py
from __future__ import annotations

import re


def _kw_in_text(keyword: str, text: str) -> bool:
    """Case-insensitive whole-word match. Multi-word keywords: substring match."""
    kw = keyword.strip()
    if not kw:
        return False
    if " " in kw:
        return kw.lower() in text.lower()
    return bool(re.search(r"(?i)\b" + re.escape(kw) + r"\b", text))


def partition_keywords(
    keywords: list[str],
    all_bullets: list[str],
) -> tuple[list[str], list[str], dict[str, list[int]]]:
    """
    Returns:
      present  : keywords already found in at least one bullet
      missing  : keywords not found anywhere
      coverage : {keyword: [bullet_indices where it appears]}
    """
    present: list[str] = []
    missing: list[str] = []
    coverage: dict[str, list[int]] = {}

    for kw in keywords:
        hits = [i for i, b in enumerate(all_bullets) if _kw_in_text(kw, b)]
        if hits:
            present.append(kw)
            coverage[kw] = hits
        else:
            missing.append(kw)
            coverage[kw] = []

    return present, missing, coverage
```

- [ ] Create file with code above
- [ ] `python -c "from fletcher.keyword_check import partition_keywords; p,m,c = partition_keywords(['Python','MongoDB'],['Built Python service.','Used SQL.']); assert p==['Python'] and m==['MongoDB'], (p,m); print('ok')"` → ok
- [ ] Commit: `git add fletcher/keyword_check.py && git commit -m "add keyword presence check"`

---

## Task 3: LLM enrich logging + preserve-list on bullet rewrite

Files: Modify `fletcher/llm/llm_enrich.py`

Three changes:
1. `enrich_with_ollama_if_enabled()` + `generate_summary()` + `rewrite_bullet_targeted()` each accept optional `logger: PipelineLogger | None = None`
2. Each call `logger.llm_call(...)` after the Ollama response
3. `rewrite_bullet_targeted()` gains `keywords_to_preserve: list[str] = []` — these are already-present keywords in this bullet that must not be removed

Prompt change for bullet rewrite (current has no preserve concept):
```python
preserve_line = ""
if keywords_to_preserve:
    preserve_line = f"Keywords already in this bullet that must stay: {', '.join(keywords_to_preserve)}.\n"

prompt = (
    f"Lightly rephrase this resume bullet to naturally weave in these keywords where they fit: {kw_list}\n"
    f"{preserve_line}"
    f"Rules:\n"
    f"- Preserve ALL original facts, metrics, and numbers exactly.\n"
    f"- Keep approximately the same length and sentence structure.\n"
    f"- Only substitute or insert a keyword where it genuinely fits the meaning.\n"
    f"- Do NOT collapse multiple ideas into one sentence.\n"
    f"- Do NOT remove any information.\n"
    f"- If no keyword fits naturally, return the bullet completely unchanged.\n"
    f"Bullet: {bullet.strip()}\n"
    f'Return only: {{"bullet": "..."}}'
)
```

After Ollama call: `if logger: logger.llm_call("bullet_rewrite", prompt, raw, result["duration_ms"], ...)`
Same pattern for `enrich_with_ollama_if_enabled` and `generate_summary`.

- [ ] Add `from fletcher.pipeline_logger import PipelineLogger` import (TYPE_CHECKING guard ok)
- [ ] Add `logger` param to all 3 functions, default `None`
- [ ] Add `keywords_to_preserve` param to `rewrite_bullet_targeted`, update prompt
- [ ] Add `logger.llm_call(...)` after each Ollama response in all 3 fns
- [ ] `python ci.py` → passes (python + frontend)
- [ ] Commit: `git add fletcher/llm/llm_enrich.py && git commit -m "add logger+preserve-list to LLM fns"`

---

## Task 4: Round-Robin Page-Fit Trim

Files: Modify `fletcher/pipeline.py`

Replace `_trim_resume_for_page_fit()` with `_trim_one_bullet_per_entry()`:

```python
def _trim_one_bullet_per_entry(doc, structured_output: dict) -> bool:
    """Remove 1 bullet from each experience+project entry in order. Returns True if any removed."""
    trimmed = False

    # Projects first (lower priority content)
    for entry in doc.projects:
        if len(entry.bullets) > 1:
            entry.bullets.pop()
            for s in structured_output.get("project_entries", []):
                if s.get("entry_id") == entry.entry_id and s.get("bullet_plan"):
                    s["bullet_plan"].pop()
                    break
            trimmed = True

    # Then experience
    for entry in doc.experience:
        if len(entry.bullets) > 1:
            entry.bullets.pop()
            for s in structured_output.get("experience_entries", []):
                if s.get("entry_id") == entry.entry_id and s.get("bullet_plan"):
                    s["bullet_plan"].pop()
                    break
            trimmed = True

    # Last resort: drop an entire project or experience entry
    if not trimmed:
        if doc.projects:
            removed = doc.projects.pop()
            structured_output["project_entries"] = [
                e for e in structured_output.get("project_entries", [])
                if e.get("entry_id") != removed.entry_id
            ]
            return True
        if len(doc.experience) > 1:
            removed = doc.experience.pop()
            structured_output["experience_entries"] = [
                e for e in structured_output.get("experience_entries", [])
                if e.get("entry_id") != removed.entry_id
            ]
            return True

    return trimmed
```

Update `_compile_with_fit_retry` to call `_trim_one_bullet_per_entry` instead of `_trim_resume_for_page_fit`.

- [ ] Replace old `_trim_resume_for_page_fit` with `_trim_one_bullet_per_entry` in `pipeline.py`
- [ ] Update call site in `_compile_with_fit_retry`
- [ ] `python ci.py` → passes
- [ ] Commit: `git add fletcher/pipeline.py && git commit -m "round-robin bullet trim for page fit"`

---

## Task 5: Ad-Hoc Pipeline (Option B Clean Flow)

Files: Create `fletcher/ad_hoc_pipeline.py`

This is the core of the rewrite. Full pipeline for Option B:

```
JD + .tex → LLM keywords → partition present/missing → RAG(missing) → LLM rewrite(high) → LLM summary(mid) → compile 2 versions → return {pdf_no_summary, pdf_summary, log}
```

Key behaviors:
- Parse uploaded `.tex` as-is — ALL original bullets kept, no selection/scoring
- collect all_bullets = experience bullets + project bullets (flat list with source tracking)
- LLM keyword extraction (Step 1): always attempt Ollama; if unavailable, keywords = []
- Keyword partition (Step 2): present vs missing
- RAG (Step 3): only pass `missing` keywords to `match_keywords_to_bullets()`; RAG requires Ollama embed model
- LLM bullet rewrite (Step 4): for each `(bullet_idx, matched_keywords)` from high tier:
  - find which `present` keywords appear in that specific bullet → `keywords_to_preserve`
  - call `rewrite_bullet_targeted(bullet, matched_keywords, keywords_to_preserve, logger)`
  - patch rewritten text back into the doc
- LLM summary (Step 5): `generate_summary()` using mid-tier keywords
- Compile no-summary version with round-robin trim
- If summary generated: compile with-summary version with round-robin trim
- Write log to `attempt_dir/pipeline_log.txt`
- Return `{pdf_path, pdf_path_summary, log_path, ...}`

```python
# fletcher/ad_hoc_pipeline.py
from __future__ import annotations

import copy
import time
from pathlib import Path

from .config import (
    DEFAULT_MODEL_BACKEND,
    OLLAMA_MODEL_NAME,
    DEFAULT_OG_RESUME_PATH,
    PROMPT_VERSION_TAG,
)
from .keyword_check import partition_keywords
from .llm.llm_enrich import enrich_with_ollama_if_enabled, generate_summary, rewrite_bullet_targeted
from .llm.rag import match_keywords_to_bullets
from .pipeline import _compile_with_fit_retry  # reuse compile+trim loop
from .pipeline_logger import PipelineLogger
from .resume.compiler import compile_tex
from .resume.parser import parse_resume_file
from .resume.renderer import render_resume_tex
from .storage import build_attempt_dir, ensure_dir, write_json, write_text
from . import config as _config
from .jobs.classifier import classify_job, slugify


def run_ad_hoc_pipeline(
    *,
    title: str,
    description: str,
    company: str = "",
    label: str | None = None,
    resume_path: str | Path = DEFAULT_OG_RESUME_PATH,
) -> dict:
    logger = PipelineLogger()
    t_start = time.perf_counter()

    # 1. Parse resume (keep ALL bullets, no selection)
    logger.step("parse_resume", path=str(resume_path))
    parsed = parse_resume_file(resume_path)

    # Flatten all bullets with source tracking
    all_bullets: list[str] = []
    bullet_sources: list[dict] = []  # {kind: exp|proj, entry_idx, bullet_idx}
    for ei, entry in enumerate(parsed.experience):
        for bi, bullet in enumerate(entry.bullets):
            all_bullets.append(bullet)
            bullet_sources.append({"kind": "exp", "entry_idx": ei, "bullet_idx": bi})
    for pi, entry in enumerate(parsed.projects):
        for bi, bullet in enumerate(entry.bullets):
            all_bullets.append(bullet)
            bullet_sources.append({"kind": "proj", "entry_idx": pi, "bullet_idx": bi})

    # 2. LLM: JD → keywords
    from .jobs.classifier import classify_job
    from .jobs.keyword_extractor import extract_keywords
    classification = classify_job(title=title, description=description)
    keywords_dict = extract_keywords(title=title, description=description, classification=classification)
    classification, keywords_dict, llm_meta = enrich_with_ollama_if_enabled(
        title=title, description=description,
        classification=classification, keywords=keywords_dict,
        logger=logger,
    )
    raw_keywords: list[str] = keywords_dict.get("must_have_terms", [])
    logger.step("keywords_extracted", count=len(raw_keywords), keywords=raw_keywords)

    # 3. Partition: present vs missing
    present_kws, missing_kws, coverage = partition_keywords(raw_keywords, all_bullets)
    logger.step("keyword_partition", present=present_kws, missing=missing_kws, coverage=coverage)

    # 4. RAG: match missing keywords to bullets
    kw_match: dict = {
        "bullet_matches": [], "summary_keywords": list(missing_kws),
        "ignored_keywords": [], "scores": [], "rag_used": False,
    }
    if _config.RAG_ENABLED and missing_kws and all_bullets:
        try:
            kw_match = match_keywords_to_bullets(missing_kws, all_bullets)
            kw_match["rag_used"] = True
        except Exception as exc:
            logger.step("rag_skipped", reason=str(exc))

    logger.step("rag_complete",
                high=len(kw_match["bullet_matches"]),
                mid=len(kw_match["summary_keywords"]),
                low=len(kw_match.get("ignored_keywords", [])))

    # 5. LLM bullet rewrites (high-tier only)
    doc = copy.deepcopy(parsed)
    doc.summary = ""

    if kw_match["bullet_matches"]:
        from collections import defaultdict
        by_bullet: dict[int, list[str]] = defaultdict(list)
        for m in kw_match["bullet_matches"]:
            by_bullet[m["bullet_idx"]].append(m["keyword"])

        for bullet_idx, kws_to_add in sorted(by_bullet.items()):
            original_text = all_bullets[bullet_idx]
            # Find already-present keywords in this specific bullet
            kws_to_preserve = [k for k in present_kws if any(k.lower() in original_text.lower() for k in [k])]
            result = rewrite_bullet_targeted(
                original_text, kws_to_add,
                keywords_to_preserve=kws_to_preserve,
                logger=logger,
            )
            if result["success"]:
                src = bullet_sources[bullet_idx]
                if src["kind"] == "exp":
                    doc.experience[src["entry_idx"]].bullets[src["bullet_idx"]] = result["bullet"]
                else:
                    doc.projects[src["entry_idx"]].bullets[src["bullet_idx"]] = result["bullet"]

    # 6. LLM summary (mid-tier keywords)
    exp_lines = [f"{e.title_company_location}" for e in doc.experience[:3]]
    candidate_context = "; ".join(exp_lines)
    summary_meta: dict = {}
    if candidate_context:
        summary_meta = generate_summary(candidate_context, title, kw_match["summary_keywords"], logger=logger)

    # 7. Build attempt dir + write artifacts
    ad_hoc_label = label or slugify(f"{company}_{title}") or "ad_hoc"
    attempt_dir = ensure_dir(build_attempt_dir(job_id=None, role_family="ad_hoc", ad_hoc_label=ad_hoc_label))

    write_json(attempt_dir / "keywords.json", {
        "raw": raw_keywords, "present": present_kws,
        "missing": missing_kws, "coverage": coverage,
        "kw_match": kw_match,
    })

    # 8. Compile no-summary version
    doc_ns = copy.deepcopy(doc)
    so_ns: dict = {"experience_entries": [], "project_entries": []}
    _, cr_ns, tex_ns, _ = _compile_with_fit_retry(attempt_dir, doc_ns, so_ns, stem="output")

    # 9. Compile with-summary version (if summary available)
    pdf_summary: str | None = None
    tex_summary: str | None = None
    _generated_summary = summary_meta.get("summary", "")
    if _generated_summary:
        doc_s = copy.deepcopy(doc)
        doc_s.summary = _generated_summary
        so_s: dict = {"experience_entries": [], "project_entries": []}
        _, cr_s, tex_s, _ = _compile_with_fit_retry(attempt_dir, doc_s, so_s, stem="output_summary")
        pdf_summary = cr_s.get("pdf_path")
        tex_summary = tex_s

    # 10. Write log
    log_text = logger.get_log_text()
    log_path = str(write_text(attempt_dir / "pipeline_log.txt", log_text))

    total_ms = int((time.perf_counter() - t_start) * 1000)
    logger.step("done", total_ms=total_ms)

    return {
        "attempt_dir": str(attempt_dir),
        "pdf_path": cr_ns.get("pdf_path"),
        "tex_path": tex_ns,
        "pdf_path_summary": pdf_summary,
        "tex_path_summary": tex_summary,
        "log_path": log_path,
        "compile_status": cr_ns.get("compile_status"),
        "fits_one_page": cr_ns.get("fits_one_page"),
        "keywords": raw_keywords,
        "present_keywords": present_kws,
        "missing_keywords": missing_kws,
    }
```

- [ ] Create `fletcher/ad_hoc_pipeline.py` with code above
- [ ] `python -c "from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline; print('import ok')"` → ok
- [ ] `python ci.py` → passes
- [ ] Commit: `git add fletcher/ad_hoc_pipeline.py && git commit -m "ad-hoc pipeline: clean keyword-inject flow"`

---

## Task 6: Wire Ad-Hoc Pipeline into Backend

Files: Modify `backend/app.py` (tailor endpoint only)

Replace call to `generate_resume_for_ad_hoc` with `run_ad_hoc_pipeline`.
Return 3 base64 blobs: `no_summary`, `with_summary`, `log`.

```python
@app.post("/api/fletcher/tailor")
async def api_fletcher_tailor(
    job_details: str = Form(...),
    personal_details: str = Form(""),  # kept for API compat, ignored in new flow
    resume: UploadFile | None = File(None),
    _auth: str = Depends(require_auth),
):
    try:
        from fletcher.ad_hoc_pipeline import run_ad_hoc_pipeline
    except ModuleNotFoundError:
        raise HTTPException(status_code=503, detail="Fletcher not available")

    import base64, tempfile

    resume_tmp = None
    try:
        if resume and resume.filename:
            suffix = Path(resume.filename).suffix or ".tex"
            resume_tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
            resume_tmp.write(await resume.read())
            resume_tmp.flush()
            resume_tmp.close()

        result = run_ad_hoc_pipeline(
            title="",
            description=job_details,
            resume_path=resume_tmp.name if resume_tmp else DEFAULT_OG_RESUME_PATH,
        )
    finally:
        if resume_tmp:
            Path(resume_tmp.name).unlink(missing_ok=True)

    def _b64(path: str | None) -> str | None:
        if path and Path(path).exists():
            return base64.b64encode(Path(path).read_bytes()).decode("ascii")
        return None

    no_summary = _b64(result.get("pdf_path"))
    with_summary = _b64(result.get("pdf_path_summary"))
    log_b64 = _b64(result.get("log_path"))

    if not no_summary and not with_summary:
        raise HTTPException(status_code=500, detail=result.get("compile_status") or "PDF generation failed")

    return JSONResponse({
        "no_summary": no_summary,
        "with_summary": with_summary,
        "log": log_b64,
        "compile_status": result.get("compile_status"),
        "fits_one_page": result.get("fits_one_page"),
    })
```

Note: `DEFAULT_OG_RESUME_PATH` needs to be imported from `fletcher.config` at top of app.py import guard.

- [ ] Replace tailor endpoint in `backend/app.py`
- [ ] `python ci.py` → passes
- [ ] Commit: `git add backend/app.py && git commit -m "tailor endpoint: use ad_hoc_pipeline, return 3 files"`

---

## Task 7: Frontend — 3 Downloads + Drag-Drop

Files: Modify `frontend/src/api/control.ts`, `frontend/src/pages/Fletcher/index.tsx`

### control.ts change
```typescript
export type TailorResult = {
  noSummary: Blob | null
  withSummary: Blob | null
  log: Blob | null        // NEW
}

// In tailorResume(): after r.json():
return {
  noSummary: json.no_summary ? _b64ToBlob(json.no_summary) : null,
  withSummary: json.with_summary ? _b64ToBlob(json.with_summary) : null,
  log: json.log ? new Blob([atob(json.log)], { type: 'text/plain' }) : null,
}
```

### index.tsx changes
1. Add `log` download button (3rd link):
```tsx
{tailorResult.log ? (
  <a className={styles.downloadLink}
     href={URL.createObjectURL(tailorResult.log)}
     download="pipeline_log.txt">
    ↓ Download log
  </a>
) : null}
```

2. Drag-drop on file label:
```tsx
const handleDrop = (e: React.DragEvent) => {
  e.preventDefault()
  const file = e.dataTransfer.files?.[0]
  if (file) setResumeFile(file)
}

const handleDragOver = (e: React.DragEvent) => e.preventDefault()
```

Add `onDrop={handleDrop} onDragOver={handleDragOver}` to the outer `<div className={styles.fileRow}>`.

Also add visual cue: `[dragging]` state + CSS class on drag-enter/leave.

- [ ] Update `TailorResult` in `control.ts` + `tailorResume()` return value
- [ ] Add 3rd download link in `index.tsx`
- [ ] Add `handleDrop` / `handleDragOver` state + handlers
- [ ] Add drag-over CSS class in `Fletcher.module.css` (dashed border, accent color)
- [ ] `npm run typecheck && npx prettier --check src` → clean
- [ ] `python ci.py` → passes
- [ ] Commit: `git add frontend/src/api/control.ts frontend/src/pages/Fletcher/index.tsx frontend/src/pages/Fletcher/Fletcher.module.css && git commit -m "3 downloads + drag-drop on Option B"`

---

## Execution Order

1 → 2 → 3 → 4 → 5 → 6 → 7

Each task ends with a passing `python ci.py`. Do not proceed to next task if CI fails.

## Test After All Tasks

Manual test via Option B UI:
1. Upload `main.tex`
2. Paste any JD with obvious tech keywords (TypeScript, React, AWS)
3. Hit Generate
4. Verify: 3 download links appear
5. Open `resume_no_summary.pdf` — no duplicate bullets, new keywords present where they fit
6. Open `resume_with_summary.pdf` — summary section at top, fewer bullets (still 1 page)
7. Open `pipeline_log.txt` — each LLM call logged with prompt + response

## Notes

- If Ollama down: keywords = [], no RAG, no rewrites, no summary. Resume returned as-is. Log shows each skipped step.
- `personal_details` field kept in form for API compat but ignored by new flow. Remove from UI in a later cleanup pass.
- RAG requires embed model (`mxbai-embed-large`). If unavailable, high-tier matches = [], mid = all missing keywords → summary only.
