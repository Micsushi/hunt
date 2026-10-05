# Postflight Comparison Contract

Stage 3 comparison uses three independent evidence layers:

1. Schema-v1 structured facts are authoritative for exact candidate facts when supplied.
2. Source LaTeX/text remains authoritative for preservation checks.
3. A supplied PDF and its extracted text are authoritative for artifact checks.

A JD can make an addition relevant. It never proves the candidate owns that fact.

## Structured Facts

Use `--before-facts`, `--after-facts`, and optional `--profile-facts` with this compact schema:

```json
{
  "schema_version": 1,
  "facts": [
    {
      "id": "experience.primary.employer",
      "kind": "experience",
      "field": "employer",
      "entry_id": "experience.primary",
      "value": "Synthetic Systems Cooperative",
      "immutable": true,
      "material": false,
      "confidence": "high"
    }
  ]
}
```

- `id`, `kind`, `field`, and `value` are required strings.
- `id` is stable and unique within one fact set.
- `entry_id` is required for structured education/experience facts and pairs their fields. Array
  position is never a pairing key.
- `immutable` enables exact normalized regression checks.
- `material` enables tailored-only grounding checks.
- `confidence` is `high`, `medium`, or `low`; structured facts default to `high`.
- Values are comparison-only. Reports retain field/entry metadata and counts, not values.

Normalization covers case/space, LaTeX escapes, phone formatting, common month/date forms, and a
small owned US-region abbreviation map. Source-only extraction is deliberately narrow and
low-confidence.

## Strength Policy

Use `--policy` with exact protected fact IDs:

```json
{
  "protected_ids": ["skill.typescript"],
  "omitted_ids": [],
  "strength_severity": "warning"
}
```

Every omission must be an exact member of `protected_ids`. Unknown protected/omission IDs are invalid
input (exit `64`). Omitted IDs remain visible as sanitized IDs/counts.

## Commands

Passing structured facts plus real PDF:

```powershell
node checker/scripts/compare.mjs `
  --before fixtures/compare/source.tex `
  --after fixtures/compare/tailored-valid.tex `
  --before-facts fixtures/compare/source.facts.json `
  --after-facts fixtures/compare/tailored-valid.facts.json `
  --pdf resume/output/ats.pdf `
  --out .runtime/reports/compare-valid.json
```

Confirmed regression:

```powershell
node checker/scripts/compare.mjs `
  --before fixtures/compare/source.tex `
  --after fixtures/compare/tailored-fact-change.tex `
  --before-facts fixtures/compare/source.facts.json `
  --after-facts fixtures/compare/tailored-fact-change.facts.json `
  --out .runtime/reports/compare-fail.json
```

Exit `0` means `pass` or `pass_with_warnings`; `2` means a completed quality failure; `64` invalid
input; `69` missing strict required capability; `70` unexpected failure. Reports are schema v1,
local-only, and sanitized.

The full synthetic matrix lives in `fixtures/compare/manifest.json`. It includes equivalent
formatting, immutable changes, protected loss, intentional omission, profile-grounded and JD-only
additions, synonym ambiguity, nonmaterial additions, source-only ambiguity, malformed facts, and a
corrupt PDF. `npm run compare:fixtures` executes all expected statuses and exits. Generated
PDF/text evidence remains ignored.
