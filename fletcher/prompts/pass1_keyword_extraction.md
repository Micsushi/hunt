# Pass 1 : Keyword Extraction Prompt

## Goal

Extract the most important hiring signals from the JD before any resume rewrite happens.

## Inputs

- job metadata
- JD text
- role classification

## Output Rules

- return JSON only
- follow `schemas/keyword_extraction.schema.json`
- separate must-have terms from nice-to-have terms
- preserve exact wording from the JD when useful
- include concern flags if the JD is weak

## Guardrails

- do not invent requirements that are not in the JD
- prefer exact terminology over paraphrase
- keep the output concise and ranked

