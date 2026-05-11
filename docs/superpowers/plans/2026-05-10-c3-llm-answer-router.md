# C3 LLM Answer Router

Date: 2026-05-10

## Goal

Add grounded local/cloud LLM calls for C3 custom application questions without putting model startup, container control, or cloud API keys inside the Chrome extension.

## Architecture

The Chrome extension remains a field detector and filler. It should never start Docker/Ollama containers and should never hold Gemini, Claude, OpenAI, or OpenRouter keys.

C3 sends unresolved required questions to the Hunt backend. The backend decides:

1. Can deterministic profile rules answer this safely?
2. If not, is a configured LLM provider available?
3. If the provider is local Ollama, is Ollama reachable?
4. If the provider is cloud, is the cloud confirmation setting enabled and is the provider key configured?
5. Does the model return schema-valid JSON?
6. Does deterministic validation prove the returned answer matches the available options and cites an allowed profile/resume/job source?

Only then does the extension fill the answer.

## Provider Reuse

Reuse the existing C2 provider abstraction:

- `fletcher.llm.client.generate_json`
- `fletcher.llm.providers.ollama`
- `fletcher.llm.providers.openai_provider`
- `fletcher.llm.providers.openrouter`
- `fletcher.llm.providers.anthropic_provider`
- `fletcher.llm.providers.gemini`

Provider settings already live under `component_settings` with `component='c2'`:

- `llm_provider`
- `llm_model`
- `cloud_llm_confirm`
- provider API keys
- `ollama_host`
- `ollama_model`
- `ollama_timeout_sec`
- `ollama_keep_alive`

Short term, C3 can read the same provider settings as C2. Later, if C3 needs different models or privacy controls, add a separate `component='c3'` settings layer that falls back to C2.

## Backend Modules

Proposed files:

- `c3_answering/schemas.py`: request/response Pydantic models.
- `c3_answering/prompts.py`: prompt builders only, no provider code.
- `c3_answering/deterministic.py`: profile rules and exact option matching.
- `c3_answering/pipeline.py`: deterministic first, LLM fallback, validation, logging.
- `c3_answering/provider_status.py`: provider availability checks.
- `tests/test_component3_answer_router.py`: schema, guardrail, provider routing, and prompt cases.

Backend routes:

- `POST /api/c3/answer-decision`: answer one unresolved field.
- `POST /api/c3/answer-decisions`: optional batch route after single-field flow is stable.
- `GET /api/c3/llm-status`: show configured provider, local availability, and cloud blocked/ready state without exposing secrets.

## Extension Flow

1. Detect visible fields and options.
2. Try deterministic local filler.
3. For required unanswered fields only, send a compact decision request to backend.
4. Receive one constrained decision.
5. Fill only if validation status is `fillable`.
6. Log the prompt case, provider, model, source fields, confidence, chosen option, and validation result.
7. Leave low-confidence or unsupported questions blank and mark manual review.

## Request Shape

```json
{
  "url": "https://careers.example.com/apply",
  "host": "careers.example.com",
  "ats": "greenhouse",
  "job": {
    "title": "Junior AI Software Engineer",
    "company": "Hootsuite",
    "description_excerpt": ""
  },
  "field": {
    "label": "How many co-op terms have you completed to date?",
    "required": true,
    "kind": "combobox",
    "options": [
      "0 terms completed, this will be my 1st term",
      "1 term completed, this will be my 2nd term"
    ]
  },
  "profile": {
    "location": "Edmonton, AB",
    "workAuthorized": true,
    "salaryFlexible": true,
    "coOpTermsCompleted": "0",
    "availableSummer2026": "yes",
    "availableInterviewWindow": "yes",
    "expectedGraduationYear": "2026",
    "previousEmployers": ""
  },
  "policy": {
    "required_only": true,
    "allow_generated_paragraphs": false,
    "allow_cloud": false
  }
}
```

## Response Shape

```json
{
  "status": "fillable",
  "action": "select_option",
  "canonical_field": "co_op_terms_completed",
  "selected_option": "0 terms completed, this will be my 1st term",
  "answer_text": "",
  "confidence": 0.94,
  "source_fields": ["profile.coOpTermsCompleted"],
  "provider": "deterministic",
  "model": "",
  "reason": "Question asks completed co-op terms and profile says 0.",
  "requires_review": false
}
```

Allowed statuses:

- `fillable`
- `manual_review`
- `skip`
- `provider_unavailable`
- `validation_failed`

## Prompt Cases

### Profile Fact To Option

Use for questions that should map to a saved profile fact: co-op terms, graduation year, prior employer, work authorization, sponsorship, relocation, salary comfort, availability, education, phone type.

Rules:

- The model may classify the question and choose one option.
- The model must cite one or more exact profile fields.
- The selected option must exactly match a provided option after normalization.
- If no profile fact exists, return `manual_review`.

### Yes/No Policy Question

Use for work authorization, salary comfort, relocation, interview availability, term availability, previously worked at employer.

Rules:

- Prefer deterministic rules.
- The model can route unfamiliar wording to a canonical field.
- If the answer depends on legal/visa nuance and no explicit profile value exists, return `manual_review`.

### Location Option Resolver

Use for city/province/country dropdowns.

Rules:

- Prefer deterministic geography first.
- If exact city is absent, choose the most truthful broader option, such as `Elsewhere in Canada`.
- Never choose an exact city/province that does not match the profile.

### Generated Paragraph

Use for required text questions like why this company, why this role, or describe relevant experience.

Rules:

- Only enabled when the operator setting allows generated paragraphs.
- Use candidate profile, selected resume facts, and job description excerpts.
- Return answer text plus citations to source fields.
- If context is thin, return `manual_review`.

### Sensitive Or Optional Fields

Use for EEO, demographics, disability, veteran status, gender, race, pronouns, and voluntary identity questions.

Rules:

- Optional sensitive fields are skipped by default.
- Required sensitive fields are answered only from explicit operator-configured preferences.
- Otherwise return `manual_review`.

### Site Memory

Use after the operator manually fixes a repeated question.

Rules:

- Store normalized host/form/question signature.
- Store whether it maps to a canonical profile field or a fixed answer.
- Reuse only when the same or highly similar question and option set appears.

## Validation Rules

- JSON must pass Pydantic schema validation.
- `selected_option` must match one of the browser-provided options.
- `source_fields` must exist in the allowed profile/resume/job context.
- The model cannot invent values not present in profile/resume/job context.
- Confidence below threshold becomes `manual_review`.
- Final submit remains human-gated.
- Every answer decision is logged to `logs/c3_extension_debug.jsonl` through the local debug sink.

## Implementation Order

1. Add backend answer schemas and deterministic-only pipeline. Done 2026-05-10.
2. Add `/api/c3/answer-decision` and unit tests. Done 2026-05-10.
3. Add provider status route and Ollama reachability check. Done 2026-05-10.
4. Add prompt templates and LLM fallback through `fletcher.llm.client.generate_json`. Done 2026-05-10.
5. Add validators and retry-on-invalid-output once. Exact-option validation done 2026-05-10; repair retry still open.
6. Wire extension only for required unanswered fields. Done 2026-05-10 for fixed-choice fields with visible/collectable options.
   - Updated flow: first fill pass is deterministic only. If unanswered required fixed-choice fields remain, C3 shows an in-page prompt asking whether to use LLM help. The backend/LLM pass runs only after the operator clicks `Use LLM`.
7. Add Options toggles: enable C3 LLM fallback, allow cloud provider, allow generated paragraphs.
8. Add logs and UI evidence for every answer decision.
9. Add manual mapping memory after live testing shows stable signatures.

## Open Decisions

- Whether C3 should use C2 provider settings forever or have its own `component='c3'` settings with C2 fallback.
- Whether medium-confidence LLM decisions should fill with a review flag or always stay manual.
- Whether generated paragraphs should be allowed during early testing or kept disabled until fixed-choice questions are stable.
