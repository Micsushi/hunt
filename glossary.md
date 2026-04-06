# Component 2 : Glossary

## Purpose

This file standardizes the shorthand and terms used across the Hunt docs so future agents and prompts read the same way.

## Terms

### C1

Component 1.

In this repo, C1 is job discovery and enrichment.

### C2

Component 2.

In this repo, C2 is resume tailoring.

### C3

Component 3.

In this repo, C3 is application automation.

### S1, S2, S3, ...

Stage numbers inside the currently discussed component unless the doc explicitly says otherwise.

Example:
- `C2 S1` means Component 2 Stage 1
- `C1 S4` means Component 1 Stage 4

### JD

Job description.

This can come from:
- an enriched C1 job row
- a pasted manual input
- an uploaded JD text file

### UI enrich

The visible-browser follow-up enrichment path in C1 when the normal unattended pass is not enough.

### OG resume

Original resume.

For now, this means:
- `main.tex`

The OG resume is the source of truth and should remain unchanged.

### Base resume

A curated starting resume used before tailoring.

Examples:
- a `software` base resume
- a `pm` base resume
- a `data` base resume
- the OG resume when no family-specific base is available

### Role family

The coarse job category used to choose a starting resume and prioritize bullets.

Initial families:
- `software`
- `pm`
- `data`
- `general`
- `unknown`

### Job level

The seniority bucket inferred from the JD.

Initial levels:
- `intern`
- `new_grad`
- `junior`
- `mid`
- `senior`
- `staff`
- `principal`
- `manager`
- `director`
- `unknown`

### Candidate profile

A user-maintained facts file with truthful material beyond what is currently visible in the OG resume.

Examples:
- extra projects
- extra role facts
- awards
- leadership examples
- PM examples
- data examples

### Bullet library

A reusable pool of truthful bullets and supporting facts that C2 can select from, rewrite, or expand.

### Attempt

One complete C2 generation run for one job or one ad hoc input.

An attempt may produce:
- a good one-page PDF
- a flagged but usable result
- a failed over-one-page output
- a fallback output

### Latest result

The current best or most recent useful C2 output surfaced on the job row and later in the web app.

### Queue-driven path

The automated C2 path triggered from normal C1 output.

### Ad hoc path

The manual C2 path where the user selects a DB job, pastes a JD, or uploads a JD text file.

### Concern flag

A limited label used by C2 to say an output may need review.

Initial flags:
- `weak_description`
- `low_confidence_match`
- `page_limit_failed`
- `insufficient_source_facts`
- `manual_review_recommended`

### One-page gate

The hard rule that a generated resume PDF must be exactly one page to count as usable.

### Latest useful result

The most recent C2 attempt that passed the one-page gate and is acceptable for downstream use.

