# Resume Quality Criteria

This checklist defines stable evaluation categories. Source and local preflight checks are partial;
complete postflight coverage is planned through RC-004. Reports point out issues and never rewrite
claims unless a future, separately approved mode owns that behavior.

## 1. Source Integrity

Purpose: make sure the resume source is versioned, reproducible, and factual.

Criteria:

- Resume source exists in a known location.
- Generated PDFs and logs are separate from source.
- Factual identity fields are stable: name, contact, school, employers, titles, dates, locations.
- No automatic rewrite changes immutable facts.
- Personal/private data handling is documented.

Potential flags:

- `missing_source_resume`
- `generated_output_committed`
- `identity_field_changed`
- `date_or_title_changed`

## 2. PDF Text-Layer Parseability

Purpose: make sure machines can read the same words humans see.

Criteria:

- Extracted text is non-empty.
- Critical terms are not split or corrupted.
- Section headings appear in expected order.
- Bullets appear under the correct role or project.
- Dates remain close to the matching entry.
- Links extract as useful text.

Potential flags:

- `pdf_text_empty`
- `keyword_broken_in_pdf_text`
- `section_order_unstable`
- `date_detached_from_role`
- `link_text_unusable`

## 3. ATS-Safe Structure

Purpose: reduce layout features that commonly confuse ATS systems.

Criteria:

- A caller-provided or optional Resume Cooker ATS-safe variant exists.
- No important content depends on columns, tables, text boxes, icons, or headers/footers.
- Standard section names are used.
- Skills are grouped in parseable plain text.
- Contact information is plain and visible.

Potential flags:

- `multi_column_layout_risk`
- `table_layout_risk`
- `icon_font_risk`
- `custom_section_heading_risk`
- `skills_section_low_signal`

Per [D1](product-decisions.md#d1-ats-variant-ownership), caller source remains authoritative and any
optional generated variant must preserve normalized facts and protected strengths.

## 4. Global Resume Positioning

Purpose: make the resume easy to classify before any JD-specific tailoring.

Criteria:

- Target role family is clear.
- Skills, experience, projects, and summary point toward the same role family.
- Strongest technical keywords are visible early.
- Older or lower-value content does not dilute the target.

Potential flags:

- `role_target_unclear`
- `skills_too_low`
- `mixed_role_signal`
- `high_value_keywords_hidden`

## 5. Evidence And Specificity

Purpose: make claims credible and useful to recruiters and automated resume filters.

Criteria:

- Impact claims include grounded context.
- Metrics are plausible and traceable.
- Technical methods are named clearly.
- Bullets avoid vague responsibility-only wording.
- Claims do not sound inflated without support.

Potential flags:

- `metric_needs_context`
- `impact_without_method`
- `responsibility_only_bullet`
- `overbroad_claim_risk`

## 6. Keyword Coverage

Purpose: make role-relevant skills and tools discoverable.

Criteria:

- Core languages, frameworks, cloud tools, databases, and workflow terms are listed.
- Important JD terms appear exactly when truthful.
- Synonyms are recognized but exact terms are preferred for must-have requirements.
- Skills are not added unless supported by source facts.

Potential flags:

- `missing_core_keyword`
- `keyword_only_in_bullet`
- `jd_must_have_missing`
- `ungrounded_keyword_risk`

## 7. Job Description Match

Purpose: evaluate fit against a specific job without overfitting or hallucinating.

Criteria:

- Must-have terms are separated from nice-to-have terms.
- Missing terms are reported with suggested evidence to add if truthful.
- Weak or generic JDs produce caution flags.
- Match score is explainable by concrete evidence.

Potential flags:

- `weak_job_description`
- `low_confidence_match`
- `must_have_gap`
- `synonym_match_needs_review`

## 8. Post-Tailoring Regression Checks

Purpose: ensure a tailored resume is not worse than the source resume.

Criteria:

- PDF still compiles.
- PDF still fits the supplied policy; ATS profile defaults to a measurable one-page blocker.
- Extracted text still passes critical keyword checks.
- Immutable facts did not change.
- Important source strengths were not accidentally removed.
- New JD-specific terms are grounded in source facts.

Structured JSON is authoritative for facts when supplied; source/LaTeX governs preservation and the
generated PDF/text governs artifact quality. Source-only extraction carries lower confidence where
structure is ambiguous. See [D4](product-decisions.md#d4-postflight-inputs).

Potential flags:

- `post_c2_compile_failed`
- `post_c2_page_limit_failed`
- `post_c2_parse_regression`
- `post_c2_fact_regression`
- `post_c2_ungrounded_addition`
- `post_c2_strength_dropped`

## Severity Model

Use four levels:

- `blocker`: likely breaks PDF generation, parsing, or factual integrity.
- `high`: likely hurts ATS/recruiter interpretation.
- `medium`: worth fixing, but not fatal.
- `low`: polish or optional improvement.

## Report Shape

Schema-v1 reports use a stable structure:

```json
{
  "schema_version": 1,
  "status": "pass | pass_with_warnings | fail",
  "resume": {
    "source": "path",
    "pdf": "path",
    "extracted_text": "path"
  },
  "checks": [
    {
      "id": "keyword_broken_in_pdf_text",
      "severity": "blocker",
      "category": "pdf_text_layer",
      "evidence": "Expected Kubernetes but extracted Kuber netes",
      "suggested_fix": "Use ATS-safe single-column layout or adjust LaTeX text run."
    }
  ]
}
```

The report explains issues and suggested directions with sanitized evidence. It does not print raw
identity/contact values or rewrite the resume. `pass_with_warnings` is completed execution and exits
`0`; quality `fail` exits `2` under [D7](product-decisions.md#d7-cli-and-report-compatibility).
