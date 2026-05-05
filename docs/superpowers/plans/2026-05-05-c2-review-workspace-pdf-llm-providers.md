# C2 Review Workspace, PDF Import, and LLM Providers Implementation Plan
> REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or executing-plans.

Goal: Replace the current post-generation PDF download flow with a GitHub-style resume diff workspace, add PDF resume import, add TeX/PDF exports, and make Fletcher work with Ollama, OpenAI, OpenRouter, Anthropic, and Gemini through one provider abstraction.

Architecture: Treat `ResumeDocument` JSON as the source of truth. The pipeline creates original, generated, and current editable copies for `no_summary` and `with_summary`; the UI edits structured blocks and the backend recompiles the current version to TeX/PDF. LLM calls go through a schema-validated `generate_json()` layer so provider-specific API shapes do not leak into C2 pipeline code.

Tech Stack: Python 3.12, FastAPI, Pydantic, httpx, pdfminer.six, pytest, React 18, TypeScript, CSS Modules, TanStack Query, jsdiff `diff`, optional Vitest for frontend reducer tests.

## Non-Negotiables

- No raw PDF editing. PDF is imported into structured resume data, then exported.
- No raw LaTeX editing in the main UI. TeX is downloadable and generated from structured JSON.
- Summary and no-summary versions are independent editable copies.
- Manual edit any text block, changed or unchanged.
- Clickable green/red diff segments can revert that segment.
- Design docs must be updated before UI implementation, and Fletcher-specific UI rules must not bloat the shared Hunt design doc.
- Cloud LLM providers must be explicit. Never silently send resume content to cloud because Ollama failed.
- Provider responses must be schema-validated after parsing, even if the provider claims structured output support.
- API keys must not be stored in `component_settings` until encrypted secret storage exists. V1 uses environment variables.

## Current Repo Facts

- C2 UI page: `frontend/src/pages/Fletcher/index.tsx`.
- C2 UI styles: `frontend/src/pages/Fletcher/Fletcher.module.css`.
- Shared UI tokens: `frontend/src/styles/tokens.css`.
- Project design source: `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/DESIGN.md`.
- C2 config: `fletcher/config.py`.
- C2 LLM code: `fletcher/llm/llm_enrich.py`, currently Ollama-specific.
- Resume model: `fletcher/resume/models.py`.
- Resume parser: `fletcher/resume/parser.py`, currently `.tex`.
- Resume renderer: `fletcher/resume/renderer.py`.
- Resume compiler: `fletcher/resume/compiler.py`.
- Option B endpoint: `backend/app.py` route `/api/fletcher/tailor`.
- Component service: `fletcher/service.py`.
- C0/C2 Docker images install Python deps from `hunter/requirements.txt`.
- Frontend has no test runner beyond `tsc` and `eslint`.

## External Docs To Recheck During Implementation

- OpenAI Structured Outputs: `https://developers.openai.com/api/docs/guides/structured-outputs`
- OpenRouter Structured Outputs: `https://openrouter.ai/docs/guides/features/structured-outputs`
- Anthropic tool use schemas: `https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools`
- Gemini structured output: `https://ai.google.dev/gemini-api/docs/structured-output`
- pdfminer.six extraction: `https://pdfminersix.readthedocs.io/en/latest/`

## Design System Plan

Shared `DESIGN.md` should stay as Hunt-wide principles and component inventory. Fletcher-specific details should move to a component design page.

Design files:
- Modify `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/DESIGN.md`.
- Create `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/design/c2-fletcher.md`.
- Optionally create `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/design/design_index.md` if the folder does not exist.

`DESIGN.md` should contain:
- Hunt-wide palette, typography, layout principles.
- A short component design index.
- C2/Fletcher summary paragraph and link to `design/c2-fletcher.md`.

`design/c2-fletcher.md` should contain:
- Resume review workspace anatomy.
- Diff color tokens and contrast rules.
- Document preview surface rules.
- Toolbar, segmented control, inspector, and dirty-state behavior.
- PDF import warning patterns.
- Cloud provider privacy warning pattern.
- Mobile/narrow behavior.
- Forbidden patterns: nested cards, raw JSON dumps, raw PDF editing, giant hero sections.

CSS token additions should happen in `frontend/src/styles/tokens.css`:

```css
--resume-paper: #fffdf8;
--resume-ink: #141813;
--resume-muted: #5f675d;
--diff-add-bg: #193524;
--diff-add-border: #59a96a;
--diff-del-bg: #3a1717;
--diff-del-border: #f05252;
--diff-neutral-bg: #162118;
--cloud-warning-bg: #2d2410;
--cloud-warning-border: #f0b429;
```

These are implementation targets; verify contrast during UI work and adjust in design docs and tokens together.

## Data Contracts

Create a review package persisted per attempt. Do not return filesystem paths to the browser.

```json
{
  "review_id": "uuid",
  "source": {
    "input_kind": "tex",
    "input_filename": "resume.tex",
    "import_status": "ok",
    "import_warnings": []
  },
  "job": {
    "title": "Software Engineer",
    "company": "",
    "description_hash": "sha256"
  },
  "llm": {
    "provider": "ollama",
    "model": "gemma4:e4b",
    "cloud": false
  },
  "keywords": {
    "raw": [],
    "present": [],
    "missing": []
  },
  "versions": {
    "no_summary": {
      "original": {},
      "generated": {},
      "current": {},
      "dirty": false,
      "compiled_revision": 0,
      "pdf_url": "/api/fletcher/reviews/:id/versions/no_summary/pdf",
      "tex_url": "/api/fletcher/reviews/:id/versions/no_summary/tex"
    },
    "with_summary": {
      "original": {},
      "generated": {},
      "current": {},
      "dirty": false,
      "compiled_revision": 0,
      "pdf_url": "/api/fletcher/reviews/:id/versions/with_summary/pdf",
      "tex_url": "/api/fletcher/reviews/:id/versions/with_summary/tex"
    }
  },
  "log_url": "/api/fletcher/reviews/:id/log"
}
```

Stable block IDs:
- `header.name`
- `header.contact_line`
- `summary`
- `education.edu_primary.header`
- `education.edu_primary.date`
- `education.edu_primary.bullet.0`
- `experience.<entry_id>.header`
- `experience.<entry_id>.date`
- `experience.<entry_id>.bullet.<index>`
- `projects.<entry_id>.header`
- `projects.<entry_id>.date`
- `projects.<entry_id>.bullet.<index>`
- `skills.languages`
- `skills.frameworks`
- `skills.developer_tools`

## Task 1: Split Hunt Design Docs For C2

Files:
- Modify `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/DESIGN.md`.
- Create `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/design/design_index.md`.
- Create `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/design/c2-fletcher.md`.
- Modify `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/hunt_index.md`.
- Modify `C:/Users/sushi/Documents/agentsvault/log.md`.

- [ ] Step 1: Create the design folder.

```powershell
New-Item -ItemType Directory -Force -Path C:\Users\sushi\Documents\agentsvault\Wiki\Projects\Hunt\design
```

- [ ] Step 2: Update `DESIGN.md` so it remains the Hunt-wide design source and links component-specific pages.

Required additions:
- A `Component Design Pages` section.
- Link `[[design/c2-fletcher|C2 Fletcher]]`.
- Rule: shared tokens live in `frontend/src/styles/tokens.css`; component exceptions must be documented in the component design page before code.

- [ ] Step 3: Create `design/c2-fletcher.md` with these sections:

```markdown
# Hunt C2 Fletcher Design

Scope: Fletcher page, resume generation form, review workspace, diff document, inspector, PDF import warnings, provider privacy warnings.

## Principles
- Operational, dense, dark-green shell.
- Resume document may use a light paper surface for readability.
- Diff interactions follow GitHub PR mental model: green additions, red deletions, selected segment inspector.
- PDF is an artifact; structured resume blocks are the editable source.

## Tokens
- `--resume-paper`
- `--resume-ink`
- `--resume-muted`
- `--diff-add-bg`
- `--diff-add-border`
- `--diff-del-bg`
- `--diff-del-border`
- `--cloud-warning-bg`
- `--cloud-warning-border`

## Layout
- Toolbar: version toggle left, status center, compile/download actions right.
- Main: resume document left, inspector right.
- Narrow: inspector becomes bottom drawer.

## Components
- Version toggle
- Review toolbar
- Resume diff document
- Diff text block
- Segment inspector
- Block editor
- Compile status bar
- Import warning
- Cloud provider warning

## Do Not
- Do not edit raw PDF.
- Do not expose raw filesystem paths.
- Do not nest cards inside cards.
- Do not use raw JSON dumps as primary UI.
- Do not use a marketing hero on Fletcher.
```

- [ ] Step 4: Update `hunt_index.md` with the new design page link.

- [ ] Step 5: Verify docs references.

```powershell
Select-String -LiteralPath C:\Users\sushi\Documents\agentsvault\Wiki\Projects\Hunt\DESIGN.md -Pattern "C2 Fletcher"
Select-String -LiteralPath C:\Users\sushi\Documents\agentsvault\Wiki\Projects\Hunt\design\c2-fletcher.md -Pattern "Resume diff document"
```

- [ ] Step 6: Commit repo changes only after the repo plan is created. Vault docs are not committed if outside repo.

## Task 2: Add Design Tokens For Diff And Resume Surfaces

Files:
- Modify `frontend/src/styles/tokens.css`.
- Modify `frontend/src/pages/Fletcher/Fletcher.module.css` only if current page needs token adoption before workspace components.

- [ ] Step 1: Add token assertions to a lightweight text test.

Create `tests/test_frontend_design_tokens.py`:

```python
from pathlib import Path


TOKENS = Path("frontend/src/styles/tokens.css")


def test_c2_resume_diff_tokens_exist():
    text = TOKENS.read_text(encoding="utf-8")
    for token in (
        "--resume-paper",
        "--resume-ink",
        "--diff-add-bg",
        "--diff-add-border",
        "--diff-del-bg",
        "--diff-del-border",
        "--cloud-warning-bg",
        "--cloud-warning-border",
    ):
        assert token in text
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_frontend_design_tokens.py -q
```

- [ ] Step 3: Add tokens to `frontend/src/styles/tokens.css`.

```css
  --resume-paper: #fffdf8;
  --resume-ink: #141813;
  --resume-muted: #5f675d;
  --diff-add-bg: #193524;
  --diff-add-border: #59a96a;
  --diff-del-bg: #3a1717;
  --diff-del-border: #f05252;
  --diff-neutral-bg: #162118;
  --cloud-warning-bg: #2d2410;
  --cloud-warning-border: #f0b429;
```

- [ ] Step 4: Run expected pass.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_frontend_design_tokens.py -q
```

- [ ] Step 5: Commit.

```powershell
git add frontend/src/styles/tokens.css tests/test_frontend_design_tokens.py
git commit -m "Add C2 review design tokens"
```

## Task 3: Add Resume Review Pydantic Models

Files:
- Create `fletcher/resume/review_models.py`.
- Create `tests/test_resume_review_models.py`.

- [ ] Step 1: Write tests.

```python
from fletcher.resume.models import (
    EducationEntry,
    EducationSection,
    ExperienceEntry,
    ResumeDocument,
    ResumeHeader,
    SkillsSection,
)
from fletcher.resume.review_models import (
    ResumeReviewVersionName,
    build_review_id,
    document_to_review_blocks,
)


def _doc() -> ResumeDocument:
    return ResumeDocument(
        source_path="<test>",
        preamble="",
        header=ResumeHeader(name="Michael Shi", contact_line="email | github"),
        summary="Backend developer.",
        education=EducationSection(
            entry=EducationEntry(
                entry_id="edu_primary",
                institution_and_degree="University",
                date_text="Sep 2026",
            ),
            bullets=["Dean's Honor Roll"],
        ),
        experience=[
            ExperienceEntry(
                entry_id="exp_acme",
                title_company_location="Developer, Acme",
                date_text="2024 - 2025",
                bullets=["Built APIs.", "Shipped tests."],
            )
        ],
        projects=[],
        skills=SkillsSection(languages=["Python"], frameworks=["FastAPI"], developer_tools=["Git"]),
    )


def test_document_to_review_blocks_has_stable_ids():
    blocks = document_to_review_blocks(_doc())
    ids = [block.block_id for block in blocks]
    assert "header.name" in ids
    assert "summary" in ids
    assert "experience.exp_acme.bullet.0" in ids
    assert "skills.languages" in ids


def test_review_version_name_values():
    assert ResumeReviewVersionName.NO_SUMMARY.value == "no_summary"
    assert ResumeReviewVersionName.WITH_SUMMARY.value == "with_summary"


def test_build_review_id_is_stable_for_attempt_dir():
    assert build_review_id("C:/tmp/attempt") == build_review_id("C:/tmp/attempt")
```

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_resume_review_models.py -q
```

- [ ] Step 3: Implement `fletcher/resume/review_models.py`.

Implementation requirements:
- Enum `ResumeReviewVersionName`: `NO_SUMMARY`, `WITH_SUMMARY`.
- Model `ResumeReviewSourceInfo`.
- Model `ResumeReviewJobInfo`.
- Model `ResumeReviewLlmInfo`.
- Model `ResumeReviewVersion`.
- Model `ResumeReviewPackage`.
- Model `ResumeReviewBlock`.
- Function `document_to_review_blocks(doc)`.
- Function `build_review_id(attempt_dir)`.

- [ ] Step 4: Run expected pass.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_resume_review_models.py -q
```

- [ ] Step 5: Commit.

```powershell
git add fletcher/resume/review_models.py tests/test_resume_review_models.py
git commit -m "Add resume review models"
```

## Task 4: Add Safe Review Artifact Store

Files:
- Create `fletcher/resume/review_store.py`.
- Create `tests/test_resume_review_store.py`.

- [ ] Step 1: Write tests.

Test cases:
- Saves `review_package.json`.
- Saves `versions/no_summary/current.json`.
- Saves `versions/with_summary/current.json`.
- Resolves by review ID without exposing arbitrary path traversal.
- Rejects `../` and unknown review IDs.

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_resume_review_store.py -q
```

- [ ] Step 3: Implement store.

Implementation requirements:
- Use `attempt_dir / "review_package.json"` as package file.
- Use `attempt_dir / "review_index.json"` or runtime root index for ad-hoc review ID lookup.
- Store only paths under `fletcher.config.resolve_runtime_root()`.
- Provide:
  - `write_review_package(attempt_dir, package)`
  - `load_review_package(review_id)`
  - `save_current_document(review_id, version, doc)`
  - `load_current_document(review_id, version)`
  - `artifact_path_for_review(review_id, version, artifact_kind)`

- [ ] Step 4: Run expected pass.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_resume_review_store.py -q
```

- [ ] Step 5: Commit.

```powershell
git add fletcher/resume/review_store.py tests/test_resume_review_store.py
git commit -m "Store resume review packages"
```

## Task 5: Generate Review Package From Ad-Hoc Pipeline

Files:
- Modify `fletcher/ad_hoc_pipeline.py`.
- Modify `fletcher/resume/review_store.py`.
- Create or modify `tests/test_ad_hoc_review_package.py`.

- [ ] Step 1: Write tests.

Test cases:
- `run_ad_hoc_pipeline()` returns `review_id`.
- Review package contains `no_summary` current document.
- If summary PDF exists, package contains `with_summary`.
- Summary and no-summary current docs are not the same object.
- Package includes PDF and TeX artifact URLs, not filesystem paths.

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_review_package.py -q
```

- [ ] Step 3: Add package creation after pipeline compile.

Implementation shape:
- Keep existing return fields for backward compatibility.
- Add `review_id`, `review_url`, and `review_package_path`.
- For `original`, use parsed uploaded/base resume before tailoring.
- For `generated`, parse final `output.tex` and `output_summary.tex` when present, or use in-memory docs before compile.
- For `current`, start as deep copy of generated.

- [ ] Step 4: Run focused tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_ad_hoc_review_package.py tests\test_ad_hoc_pipeline.py -q
```

- [ ] Step 5: Commit.

```powershell
git add fletcher/ad_hoc_pipeline.py fletcher/resume/review_store.py tests/test_ad_hoc_review_package.py
git commit -m "Create ad-hoc resume review packages"
```

## Task 6: Add Review API Endpoints In C0 Backend

Files:
- Modify `backend/app.py`.
- Create `tests/test_fletcher_review_api.py`.

- [ ] Step 1: Write tests with FastAPI `TestClient`.

Test cases:
- `GET /api/fletcher/reviews/{review_id}` returns package.
- Unknown review ID returns 404.
- `PATCH /api/fletcher/reviews/{review_id}/versions/no_summary` saves current document and marks dirty.
- `POST /api/fletcher/reviews/{review_id}/versions/no_summary/compile` returns new PDF and TeX URLs.
- Artifact endpoints serve PDF and TeX without path leakage.

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_fletcher_review_api.py -q
```

- [ ] Step 3: Implement routes.

Routes:
- `GET /api/fletcher/reviews/{review_id}`
- `PATCH /api/fletcher/reviews/{review_id}/versions/{version}`
- `POST /api/fletcher/reviews/{review_id}/versions/{version}/compile`
- `POST /api/fletcher/reviews/{review_id}/versions/{version}/revert`
- `GET /api/fletcher/reviews/{review_id}/versions/{version}/pdf`
- `GET /api/fletcher/reviews/{review_id}/versions/{version}/tex`
- `GET /api/fletcher/reviews/{review_id}/log`

Implementation rules:
- Validate `version in {"no_summary", "with_summary"}`.
- Validate request body into `ResumeDocument`.
- Compile with `render_resume_tex()` and `compile_tex()`.
- On compile failure, keep dirty state and return structured error.

- [ ] Step 4: Run expected pass.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_fletcher_review_api.py -q
```

- [ ] Step 5: Commit.

```powershell
git add backend/app.py tests/test_fletcher_review_api.py
git commit -m "Add Fletcher review API"
```

## Task 7: Change Tailor API Response To Review Package

Files:
- Modify `backend/app.py`.
- Modify `frontend/src/api/control.ts`.
- Modify `frontend/src/api/control.test-types.ts`.

- [ ] Step 1: Update TypeScript type tests.

Expected new type:

```ts
export type TailorResult = {
  reviewId: string | null
  review: ResumeReviewPackage | null
  noSummary: Blob | null
  withSummary: Blob | null
  log: Blob | null
  llmError: string | null
}
```

Keep `noSummary`, `withSummary`, and `log` during transition.

- [ ] Step 2: Run expected fail.

```powershell
cd frontend
npm run typecheck
```

- [ ] Step 3: Update backend JSON response.

Return:
- `review_id`
- `review`
- legacy `no_summary`
- legacy `with_summary`
- legacy `log`
- `llm_error`

- [ ] Step 4: Update frontend parser.

- [ ] Step 5: Run expected pass.

```powershell
cd frontend
npm run typecheck
```

- [ ] Step 6: Commit.

```powershell
git add backend/app.py frontend/src/api/control.ts frontend/src/api/control.test-types.ts
git commit -m "Return Fletcher review package"
```

## Task 8: Add Frontend Diff Dependency And Pure Diff Helpers

Files:
- Modify `frontend/package.json`.
- Modify `frontend/package-lock.json`.
- Create `frontend/src/pages/Fletcher/review/diff.ts`.
- Optional create `frontend/src/pages/Fletcher/review/diff.test.ts` if Vitest is added.

- [ ] Step 1: Add jsdiff.

```powershell
cd frontend
npm install diff
```

- [ ] Step 2: Add helper functions.

Required functions:
- `buildDiffSegments(original: string, current: string)`.
- `applySegmentRevert(current: string, segment)`.
- `isBlockChanged(original: string, current: string)`.

Behavior:
- Use `diffWordsWithSpace`.
- Collapse adjacent remove/add into replacement groups.
- Give every segment stable local ID based on block ID plus segment index.

- [ ] Step 3: If adding Vitest, install and test.

```powershell
cd frontend
npm install -D vitest
```

Add script:

```json
"test": "vitest run"
```

Test cases:
- Added text creates an addition segment.
- Removed text creates a deletion segment.
- Replacement creates a paired replacement group.
- Reverting replacement restores original phrase.

- [ ] Step 4: Run verification.

```powershell
cd frontend
npm run typecheck
npm run lint
```

If Vitest was added:

```powershell
cd frontend
npm test
```

- [ ] Step 5: Commit.

```powershell
git add frontend/package.json frontend/package-lock.json frontend/src/pages/Fletcher/review
git commit -m "Add resume diff helpers"
```

## Task 9: Build Resume Review Workspace Components

Files:
- Create `frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.tsx`.
- Create `frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.module.css`.
- Create `frontend/src/pages/Fletcher/review/types.ts`.
- Create `frontend/src/pages/Fletcher/review/documentBlocks.ts`.
- Modify `frontend/src/pages/Fletcher/index.tsx`.
- Modify `frontend/src/pages/Fletcher/Fletcher.module.css`.

- [ ] Step 1: Define frontend review types matching backend package.

- [ ] Step 2: Build document block flattening.

Required block groups:
- Header
- Summary
- Education
- Experience
- Projects
- Technical Skills

- [ ] Step 3: Build components.

Components:
- `ResumeReviewWorkspace`
- `ReviewToolbar`
- `VersionToggle`
- `ResumeDiffDocument`
- `ResumeSectionDiff`
- `DiffTextBlock`
- `SegmentInspector`
- `BlockEditor`
- `CompileStatusBar`
- `ImportWarning`
- `CloudProviderWarning`

- [ ] Step 4: Interaction behavior.

Required:
- Toggle versions without losing independent edits.
- Click segment selects it.
- Revert selected segment.
- Revert block to original.
- Reset block to generated.
- Edit block manually.
- Dirty block count updates.
- Download buttons use current artifact URLs.

- [ ] Step 5: Run frontend checks.

```powershell
cd frontend
npm run typecheck
npm run lint
```

- [ ] Step 6: Commit.

```powershell
git add frontend/src/pages/Fletcher
git commit -m "Add Fletcher review workspace"
```

## Task 10: Wire Save And Compile From Frontend

Files:
- Modify `frontend/src/api/control.ts`.
- Modify `frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.tsx`.
- Modify `frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.module.css`.

- [ ] Step 1: Add API functions.

```ts
export function fetchFletcherReview(reviewId: string): Promise<ResumeReviewPackage>
export function saveFletcherReviewVersion(reviewId: string, version: ReviewVersionName, doc: ResumeDocument): Promise<ResumeReviewPackage>
export function compileFletcherReviewVersion(reviewId: string, version: ReviewVersionName): Promise<ResumeReviewPackage>
export function revertFletcherReviewVersion(reviewId: string, version: ReviewVersionName, target: 'original' | 'generated'): Promise<ResumeReviewPackage>
```

- [ ] Step 2: Wire mutations with TanStack Query.

- [ ] Step 3: Compile success behavior.

Required:
- Clear dirty state.
- Increment compiled revision.
- Refresh PDF and TeX URLs.
- Show toast on compile failure with backend error detail.

- [ ] Step 4: Run checks.

```powershell
cd frontend
npm run typecheck
npm run lint
```

- [ ] Step 5: Commit.

```powershell
git add frontend/src/api/control.ts frontend/src/pages/Fletcher/review
git commit -m "Wire Fletcher review editing"
```

## Task 11: Add PDF Resume Import

Files:
- Modify `hunter/requirements.txt`.
- Create `fletcher/resume/importer.py`.
- Create `tests/fixtures/resume_text_pdf.py` or static fixture under `tests/fixtures`.
- Create `tests/test_resume_importer.py`.
- Modify `backend/app.py`.
- Modify `fletcher/ad_hoc_pipeline.py`.

- [ ] Step 1: Add dependency.

Add to `hunter/requirements.txt`:

```text
pdfminer.six
```

- [ ] Step 2: Write importer tests.

Test cases:
- `.tex` path delegates to `parse_resume_file`.
- Text PDF fixture imports name, education, experience bullet, and skills.
- Missing section returns import warning.
- Scanned/empty PDF returns failed import status.

- [ ] Step 3: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_resume_importer.py -q
```

- [ ] Step 4: Implement importer.

Functions:
- `parse_resume_upload(path) -> tuple[ResumeDocument, ImportReport]`.
- `extract_pdf_text(path) -> str`.
- `parse_resume_text(text, source_path) -> tuple[ResumeDocument, ImportReport]`.

Parsing rules:
- Normalize common bullets.
- Detect section headings case-insensitively.
- Preserve header name and contact line.
- Parse skills labels: Languages, Frameworks, Developer Tools.
- Unknown skills go to `developer_tools`.

- [ ] Step 5: Wire upload endpoint.

In `/api/fletcher/tailor`, keep `.tex` and `.pdf` accepted. Reject other suffixes with 400.

- [ ] Step 6: Run tests.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_resume_importer.py tests\test_ad_hoc_pipeline.py tests\test_fletcher_review_api.py -q
```

- [ ] Step 7: Commit.

```powershell
git add hunter/requirements.txt fletcher/resume/importer.py backend/app.py fletcher/ad_hoc_pipeline.py tests/test_resume_importer.py tests/fixtures
git commit -m "Import PDF resumes"
```

## Task 12: Add TeX Download For All Review Versions

Files:
- Modify `backend/app.py`.
- Modify `frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.tsx`.
- Modify tests from Task 6.

- [ ] Step 1: Extend API tests.

Assertions:
- `GET /api/fletcher/reviews/{review_id}/versions/no_summary/tex` returns `text/plain` or `application/x-tex`.
- Current edited text appears in downloaded TeX after compile.

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_fletcher_review_api.py -q
```

- [ ] Step 3: Implement TeX artifact serving for active revision.

- [ ] Step 4: Add frontend `Download TeX` action beside `Download PDF`.

- [ ] Step 5: Run checks.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_fletcher_review_api.py -q
cd frontend
npm run typecheck
npm run lint
```

- [ ] Step 6: Commit.

```powershell
git add backend/app.py frontend/src/pages/Fletcher/review tests/test_fletcher_review_api.py
git commit -m "Download edited resume TeX"
```

## Task 13: Add LLM Schema Models

Files:
- Create `fletcher/llm/schemas.py`.
- Create `tests/test_llm_schemas.py`.
- Modify `fletcher/llm/llm_enrich.py` later, not in this task.

- [ ] Step 1: Write tests.

Schema models:
- `KeywordExtractResponse`.
- `BulletRewriteResponse`.
- `RewriteValidationResponse`.
- `SummaryResponse`.

Test cases:
- Valid payload parses.
- Invalid types fail validation.
- Extra keys are rejected or ignored consistently. Recommendation: reject extras for C2 LLM task outputs.

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_llm_schemas.py -q
```

- [ ] Step 3: Implement Pydantic schemas.

Use `model_config = ConfigDict(extra="forbid")`.

- [ ] Step 4: Run expected pass.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_llm_schemas.py -q
```

- [ ] Step 5: Commit.

```powershell
git add fletcher/llm/schemas.py tests/test_llm_schemas.py
git commit -m "Add C2 LLM schemas"
```

## Task 14: Add LLM Provider Abstraction

Files:
- Create `fletcher/llm/providers/base.py`.
- Create `fletcher/llm/providers/ollama.py`.
- Create `fletcher/llm/client.py`.
- Modify `fletcher/config.py`.
- Create `tests/test_llm_provider_config.py`.
- Create `tests/test_llm_provider_ollama.py`.

- [ ] Step 1: Write provider config tests.

Test cases:
- `HUNT_RESUME_LLM_PROVIDER=ollama` selects Ollama.
- Old `HUNT_RESUME_MODEL_BACKEND=ollama` still maps to Ollama.
- `heuristic` disables cloud/local chat calls.
- Cloud provider without matching API key returns config error before prompt send.

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_llm_provider_config.py tests\test_llm_provider_ollama.py -q
```

- [ ] Step 3: Implement base interface.

Required:
- `LLMJsonResult`.
- `BaseLLMProvider.generate_json(...)`.
- `get_llm_provider()`.
- `generate_json(...)` convenience function.

- [ ] Step 4: Implement Ollama provider by moving current `_ollama_chat` behavior.

- [ ] Step 5: Run expected pass.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_llm_provider_config.py tests\test_llm_provider_ollama.py -q
```

- [ ] Step 6: Commit.

```powershell
git add fletcher/config.py fletcher/llm/client.py fletcher/llm/providers tests/test_llm_provider_config.py tests/test_llm_provider_ollama.py
git commit -m "Add C2 LLM provider base"
```

## Task 15: Add OpenAI, OpenRouter, Anthropic, And Gemini Providers

Files:
- Create `fletcher/llm/providers/openai_provider.py`.
- Create `fletcher/llm/providers/openrouter.py`.
- Create `fletcher/llm/providers/anthropic_provider.py`.
- Create `fletcher/llm/providers/gemini.py`.
- Create `tests/test_llm_provider_openai.py`.
- Create `tests/test_llm_provider_openrouter.py`.
- Create `tests/test_llm_provider_anthropic.py`.
- Create `tests/test_llm_provider_gemini.py`.

- [ ] Step 1: Write mocked HTTP tests.

Use monkeypatched `httpx.Client.post` or `httpx.post` so no external network is used.

Test cases for each provider:
- Builds expected URL.
- Sends auth header or API key query correctly.
- Sends schema in provider-specific shape.
- Parses valid response into `LLMJsonResult.parsed`.
- Handles HTTP failure with `success=False`.
- Does not include API key in error string.

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_llm_provider_openai.py tests\test_llm_provider_openrouter.py tests\test_llm_provider_anthropic.py tests\test_llm_provider_gemini.py -q
```

- [ ] Step 3: Implement providers with `httpx`.

Do not add provider SDKs in V1.

Provider request shapes:
- OpenAI: use structured output request. Prefer Responses API when current docs confirm payload shape.
- OpenRouter: chat completions with `response_format` JSON schema when supported.
- Anthropic: Messages API with a forced tool whose `input_schema` is the task schema.
- Gemini: `generateContent` with JSON response MIME type and schema.

- [ ] Step 4: Run expected pass.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_llm_provider_openai.py tests\test_llm_provider_openrouter.py tests\test_llm_provider_anthropic.py tests\test_llm_provider_gemini.py -q
```

- [ ] Step 5: Commit.

```powershell
git add fletcher/llm/providers tests/test_llm_provider_openai.py tests/test_llm_provider_openrouter.py tests/test_llm_provider_anthropic.py tests/test_llm_provider_gemini.py
git commit -m "Add cloud LLM providers"
```

## Task 16: Migrate `llm_enrich.py` To Provider Client

Files:
- Modify `fletcher/llm/llm_enrich.py`.
- Modify `tests/test_rewrite_validation.py`.
- Modify `tests/test_ad_hoc_pipeline.py`.
- Modify `tests/test_llm_enrich_logger.py`.

- [ ] Step 1: Add tests that monkeypatch `fletcher.llm.client.generate_json`.

Test cases:
- Keyword extraction uses `KeywordExtractResponse`.
- Summary generation uses `SummaryResponse`.
- Bullet rewrite uses `BulletRewriteResponse`.
- Rewrite validation uses `RewriteValidationResponse`.
- Non-Ollama providers still run validation if configured.
- Provider failure returns current fail-closed behavior.

- [ ] Step 2: Run expected fail.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_rewrite_validation.py tests\test_ad_hoc_pipeline.py tests\test_llm_enrich_logger.py -q
```

- [ ] Step 3: Replace direct `_ollama_chat` calls with `generate_json`.

Keep function names stable:
- `enrich_with_ollama_if_enabled` can be retained temporarily as compatibility wrapper, but internally call provider client.
- Later rename to `enrich_with_llm_if_enabled`.

- [ ] Step 4: Preserve logs.

Pipeline logs must include:
- provider
- model
- task name
- duration
- success/error
- no API key

- [ ] Step 5: Run expected pass.

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_rewrite_validation.py tests\test_ad_hoc_pipeline.py tests\test_llm_enrich_logger.py -q
```

- [ ] Step 6: Commit.

```powershell
git add fletcher/llm/llm_enrich.py tests/test_rewrite_validation.py tests/test_ad_hoc_pipeline.py tests/test_llm_enrich_logger.py
git commit -m "Use provider client for C2 LLM calls"
```

## Task 17: Add Cloud Provider Privacy Warning

Files:
- Modify `fletcher/config.py`.
- Modify `backend/app.py`.
- Modify `frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.tsx`.
- Modify `frontend/src/pages/Fletcher/review/ResumeReviewWorkspace.module.css`.
- Modify tests as needed.

- [ ] Step 1: Backend package includes cloud flag.

Rules:
- `cloud=false` for `heuristic` and `ollama`.
- `cloud=true` for `openai`, `openrouter`, `anthropic`, `gemini`.
- If cloud provider and `HUNT_RESUME_CLOUD_LLM_CONFIRM` is not enabled, block generation with clear 400/503 message.

- [ ] Step 2: UI warning.

Warning copy:

```text
Cloud LLM active: resume and job description text may be sent to the selected provider.
```

- [ ] Step 3: Run checks.

```powershell
.\.venv\Scripts\python.exe -m pytest tests/test_fletcher_review_api.py tests/test_llm_provider_config.py -q
cd frontend
npm run typecheck
npm run lint
```

- [ ] Step 4: Commit.

```powershell
git add fletcher/config.py backend/app.py frontend/src/pages/Fletcher/review tests
git commit -m "Warn before cloud C2 LLM use"
```

## Task 18: Add Provider Settings UI Without Storing Keys

Files:
- Modify `frontend/src/pages/Settings/index.tsx`.
- Modify `frontend/src/pages/Settings/Settings.module.css`.
- Modify `frontend/src/api/control.ts`.
- Modify `backend/app.py` if a read-only effective config endpoint is needed.

- [ ] Step 1: Add read-only C2 provider status endpoint.

Do not return keys.

Return:
- provider
- model
- cloud
- key presence booleans
- cloud confirmation flag

- [ ] Step 2: Add Settings panel.

Panel behavior:
- Show effective provider/model.
- Show whether each env key is present.
- Explain keys are configured by environment in V1.
- Do not include key input fields until encrypted settings are implemented.

- [ ] Step 3: Run checks.

```powershell
cd frontend
npm run typecheck
npm run lint
```

- [ ] Step 4: Commit.

```powershell
git add backend/app.py frontend/src/pages/Settings frontend/src/api/control.ts
git commit -m "Show C2 provider settings"
```

## Task 19: End-To-End Verification

Run all focused checks:

```powershell
.\.venv\Scripts\python.exe -m pytest tests\test_resume_review_models.py tests\test_resume_review_store.py tests\test_ad_hoc_review_package.py tests\test_fletcher_review_api.py tests\test_resume_importer.py tests\test_llm_schemas.py tests\test_llm_provider_config.py tests\test_llm_provider_ollama.py tests\test_rewrite_validation.py tests\test_ad_hoc_pipeline.py -q
.\.venv\Scripts\python.exe ci.py c2
.\.venv\Scripts\python.exe quality.py shared
cd frontend
npm run typecheck
npm run lint
npm run build
```

Manual verification:
- Start UI mode.
- Upload `.tex`, generate review package, revert one changed segment, manually edit unchanged text, compile, download PDF and TeX.
- Upload text-based PDF, verify import warning or success, generate review package, compile.
- Toggle `No summary` and `With summary`; verify edits do not sync.
- With provider `ollama`, verify no cloud warning.
- With provider `openai` and no confirmation flag, verify generation is blocked before sending prompt.
- With provider `openai` and fake key in mocked tests only, verify no key appears in logs.

## Task 20: Documentation And Vault Update

Files:
- Modify `fletcher/README.md`.
- Modify `docs/UI_CLI.md` if user-facing Fletcher UI instructions live there.
- Modify `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/c2-resume-review-diff-ui-plan.md`.
- Modify `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/integrations.md`.
- Modify `C:/Users/sushi/Documents/agentsvault/Wiki/Projects/Hunt/state-and-storage.md`.
- Modify `C:/Users/sushi/Documents/agentsvault/log.md`.

- [ ] Step 1: Update `fletcher/README.md`.

Include:
- `.pdf` and `.tex` upload support.
- PDF import limitation: text PDFs only.
- Review workspace behavior.
- Provider env vars.
- Cloud privacy warning.
- PDF and TeX export.

- [ ] Step 2: Update vault project pages.

Required:
- `integrations.md`: list providers.
- `state-and-storage.md`: review package artifact layout.
- `c2-resume-review-diff-ui-plan.md`: mark implementation status.
- `log.md`: append verification summary.

- [ ] Step 3: Run docs checks if available.

```powershell
.\.venv\Scripts\python.exe quality.py shared
```

- [ ] Step 4: Commit repo docs.

```powershell
git add fletcher/README.md docs/UI_CLI.md
git commit -m "Document Fletcher review workspace"
```

## Rollback Plan

- Keep legacy PDF blob response fields in `/api/fletcher/tailor` until the new review UI has been manually verified.
- Keep `HUNT_RESUME_MODEL_BACKEND=ollama` working as an alias.
- Keep default provider as `heuristic` unless deployment already sets Ollama.
- PDF import is additive; `.tex` upload path remains the trusted path.
- If the review workspace fails in production, expose legacy download group behind a feature flag:

```text
HUNT_FLETCHER_REVIEW_WORKSPACE=0
```

## Execution Handoff

Recommended execution mode: subagent-driven development after this plan is approved.

Suggested split:
- Worker 1: design docs, tokens, frontend diff workspace.
- Worker 2: review package, store, backend endpoints.
- Worker 3: PDF importer.
- Worker 4: LLM provider abstraction.

Disjoint write sets:
- Worker 1 owns `frontend/src/pages/Fletcher`, `frontend/src/styles/tokens.css`, frontend package files.
- Worker 2 owns `fletcher/resume/review_*`, `backend/app.py`, review API tests.
- Worker 3 owns `fletcher/resume/importer.py`, importer tests, `hunter/requirements.txt`.
- Worker 4 owns `fletcher/llm`, provider tests, config.

Do not run workers until the user approves implementation.
