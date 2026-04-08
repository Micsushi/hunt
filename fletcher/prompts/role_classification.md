# Role Classification Prompt

## Goal

Classify a job into:
- `role_family`
- `job_level`

Also flag whether the JD looks weak or noisy.

## Inputs

- job title
- company
- source
- apply host if known
- JD text

## Output Rules

- return JSON only
- use the role families defined in `schemas/role_classification.schema.json`
- use the job levels defined in `schemas/role_classification.schema.json`
- set `weak_description` when the JD is too thin or noisy for confident tailoring
- include short reasoning notes

## Guardrails

- do not fabricate missing details
- do not infer a specialized role family unless the JD supports it
- default to `general` or `unknown` when uncertain

