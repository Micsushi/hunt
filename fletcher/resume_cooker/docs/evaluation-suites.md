# Evaluation Suites

Resume Cooker can use both local checks and API-backed checks. The key boundary is that Resume Cooker owns this evaluation work; Hunt C2/Fletcher should stay local-model-first unless explicitly changed later.

**Status:** Stage 3 deterministic tester and postflight report behavior is implemented; packaged CLI
syntax below remains planned under RC-007. API live readiness is not established. Accepted policy lives in
[`docs/product-decisions.md`](product-decisions.md).

## Principles

- Local checks must be able to run offline.
- API checks must be opt-in.
- Reports must say whether resume or JD content left the machine.
- Local and API results should be comparable but not mixed silently.
- A full run executes the local and API suites in parallel; API review still remains disabled unless
  explicitly enabled.
- C2 should consume Resume Cooker results later, not inherit Resume Cooker's provider dependencies.

## Suite Types

### Local Suite

Purpose: deterministic checks and checks that can run with local tools or local models.

Examples:

- Build LaTeX to PDF.
- Extract PDF text.
- Verify critical keywords are not broken.
- Verify section order.
- Verify dates stay attached to entries.
- Compare original and generated resume facts.
- Run open-source parser tools from `testers/`.
- Run a local LLM evaluator when configured.

Expected command shape:

```bash
resume-cooker check --suite local --resume resume/source/current.tex
```

Current npm command:

```bash
npm run check:local
npm run check:local:ats
```

The ATS command targets `resume/source/ats.tex`, builds `resume/output/ats.pdf`, extracts text, and
hard-fails `pdf_page_limit` if the produced PDF is over one page. Per
[D2](product-decisions.md#d2-page-limit-severity), an unknown page count is an incomplete warning in
normal local mode and exit `69` in strict release validation.

Normal local mode keeps tester tools optional. Strict release validation requires ATS-Checker to
execute and a page count to be known. [RC-003.6](tasks/RC-003.6-tester-profiles.md) implements this
profile split.

`npm run check:testers` runs every adapter. ATS-Checker, ResumeParser, and ats-screener return
separate evidence domains; Resume-Matcher is an explicit measured deferral. The report includes
execution-state counts and parser identities but never averages parser agreement with scorer values.
`npm run check:testers:strict` runs the same profile with ATS-Checker required.

### Postflight Comparison

`npm run compare` keeps source-only comparison available. Credible Stage 3 comparison supplies
schema-v1 fact files and a real tailored PDF:

```powershell
npm run build:pdf:ats
npm run compare:fixtures
```

The comparison checks immutable facts, caller-protected strengths, intentional omissions, grounded
additions, page count, extracted text, sections/order, encoding, and ATS-Checker agreement when
available. See [`comparison-contract.md`](comparison-contract.md) for the fact/policy schemas and
the complete public fixture matrix.

### API Suite

Purpose: checks that benefit from stronger external models or provider-specific evaluation.

API findings are advisory and cannot be the sole hard blocker. Every run remains explicit, bounded,
and privacy-labeled under [D6](product-decisions.md#d6-api-review-scope).

Examples:

- Resume clarity review.
- ATS-style classification review.
- JD/resume semantic match scoring.
- Claim credibility and unsupported-term detection.
- Comparison between local evaluator and stronger API evaluator.

Expected command shape:

```bash
resume-cooker check --suite api --resume resume/source/current.tex --jd fixtures/software_engineering_intern_jd.txt
```

Current npm command:

```bash
npm run check:api
```

The API suite does not send content anywhere unless both the API suite and explicit environment
configuration are present. Supported providers are `openrouter` and `anthropic`.

PowerShell examples:

```powershell
$env:RESUME_COOKER_ALLOW_API = "true"
$env:OPENROUTER_API_KEY = "..."
npm run check:api
```

```powershell
$env:RESUME_COOKER_ALLOW_API = "true"
$env:RESUME_COOKER_API_PROVIDER = "anthropic"
$env:ANTHROPIC_API_KEY = "..."
npm run check:api
```

Optional settings:

- `RESUME_COOKER_API_MODEL`: provider model name.
- `RESUME_COOKER_API_TIMEOUT_MS`: request timeout in milliseconds.
- `OPENROUTER_SITE_URL` and `OPENROUTER_SITE_NAME`: optional OpenRouter attribution headers.

### Full Suite

Purpose: run local and API checks together when the user explicitly wants the broadest signal.

Expected command shape:

```bash
resume-cooker check --suite full --resume resume/source/current.tex --jd fixtures/software_engineering_intern_jd.txt
```

Current npm command:

```bash
npm run check:full
```

The full suite runs independent local and API reports together. Independent checks should continue
to run in parallel where possible:

- PDF extraction can run alongside local parser setup checks.
- Local model review can run alongside API review.
- Multiple API rubric checks can run concurrently when rate limits allow.

## Provider Configuration

Provider config supports:

- `none`: no model calls.
- `openrouter`: OpenRouter chat-completions adapter, default when
  `RESUME_COOKER_ALLOW_API=true`.
- `anthropic`: Anthropic messages adapter.
- Per-provider model names through `RESUME_COOKER_API_MODEL`.
- Provider timeout through `RESUME_COOKER_API_TIMEOUT_MS`.
- Input size cap through `RESUME_COOKER_API_MAX_INPUT_CHARS`, default `24000`.
- Output token cap through `RESUME_COOKER_API_MAX_TOKENS`, default `1024`.
- Explicit confirmation that private resume/JD content may leave the machine through
  `RESUME_COOKER_ALLOW_API=true`.

API checks should require explicit configuration. They should not run just because an API key exists in the environment.

## Report Metadata

Every check should report execution source:

```json
{
  "id": "semantic_jd_match",
  "suite": "api",
  "provider": "openrouter",
  "model": "example-model",
  "content_left_machine": true,
  "status": "warning",
  "severity": "medium"
}
```

Schema-v1 reports also include a top-level schema version, stable status, inputs checked, skipped
evidence, and sanitized findings. Raw contact values and source excerpts are not report evidence.

Local-model checks should also label themselves clearly:

```json
{
  "id": "local_resume_review",
  "suite": "local",
  "provider": "ollama",
  "model": "local-model-name",
  "content_left_machine": false,
  "status": "pass"
}
```

## Relationship To Hunt C2

Hunt C2 can continue using local models for resume tailoring. Resume Cooker may use API calls for
advisory evaluation because it is a separate, explicit quality gate.

Later integration should look like:

```text
Resume Cooker local preflight
Optional Resume Cooker API preflight
Hunt C2 local tailoring
Resume Cooker local postflight
Optional Resume Cooker API postflight
```

If API checks are unavailable, local checks should still provide useful pass/fail and warnings.
Hunt owns enforcement: preflight `fail` blocks Fletcher by default, warnings proceed visibly, and an
override must be explicit and audited. See [D3](product-decisions.md#d3-pre-c2-enforcement) and
[RC-008](tasks/RC-008-hunt-integration.md).
