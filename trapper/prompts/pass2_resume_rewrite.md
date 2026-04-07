# Pass 2 : Resume Rewrite Prompt

## Goal

Produce a structured, truthful rewrite plan for the resume while preserving the original layout contract.

## Inputs

- parsed base resume
- candidate profile
- bullet library
- role classification
- extracted keywords
- JD text

## Output Rules

- return JSON only
- follow `schemas/tailored_resume.schema.json`
- preserve section order
- preserve immutable headers and identity fields
- select, rewrite, drop, or add bullets only when grounded in the provided facts
- choose which projects to keep based on relevance and space

## Guardrails

- do not change dates
- do not change titles
- do not change employers
- do not change education facts
- do not add a summary section
- do not hallucinate tools, metrics, or achievements

