# Component 4 : Orchestration And Submit Control

## Goal

Build Component 4 as the orchestration layer that coordinates Components 1, 2, and 3.

Component 4 should decide:
- which jobs should proceed
- when a page should be opened
- when Component 3 should autofill
- when final submit is allowed
- when manual review or handoff is required

OpenClaw is the current most likely first implementation of Component 4.

## Why Component 4 Should Be Separate

Component 3 should remain the browser autofill engine.

If submit logic, job gating, and higher-level decision-making are mixed into Component 3, then:
- the extension becomes harder to test
- manual use becomes harder to reason about
- future orchestrators become tightly coupled to extension internals

Keeping Component 4 separate gives cleaner ownership:
- C1 finds and enriches jobs
- C2 prepares resumes
- C3 fills forms and uploads the chosen resume
- C4 coordinates the end-to-end flow and decides when submit should happen

## Current Expected Shape

Recommended first Component 4 implementation:
- OpenClaw on `server2`

Recommended role:
- inspect C1 and C2 state
- choose a ready job
- call one apply-prep command that resolves the DB row and primes C3
- trigger C3 when appropriate
- decide whether final submit should happen
- route blocked or suspicious flows to manual review

Important rule:
- C4 should consume the other components
- it should not redefine their internal contracts ad hoc

## Inputs

From Component 1:
- job metadata
- `apply_url`
- ATS type
- enriched description
- priority/manual-only signals

From Component 2:
- selected resume version
- selected resume PDF path
- resume concern flags
- generation metadata

From Component 3:
- fill results
- generated answers used
- evidence paths
- manual-review flags
- page interaction summary

## Core Responsibilities

- queue selection and gating
- end-to-end sequencing across components
- calling the shared apply-prep command for one chosen job
- deciding whether autofill should run
- deciding whether final submit should run
- handling blocked/manual-review paths
- later notifications and summaries

## Shared Apply-Prep Command

The recommended C4 interaction should not be:
- query DB manually
- build an ad hoc payload in OpenClaw prompt text
- hope C3 picks the right resume

The recommended interaction should be:

1. C4 chooses one `job_id`
2. C4 calls one apply-prep command
3. that command reads the DB row
4. that command resolves:
   - `apply_url`
   - selected resume version
   - selected resume path
5. that command opens the target page
6. that command updates C3 with the active resume context for that job
7. C4 then asks C3 to fill

Benefits:
- one source of truth for resume resolution
- less duplicated logic in OpenClaw prompts
- fewer mismatches between DB state and browser state

## Out Of Scope For Component 4

Component 4 should not own:
- scraping logic
- resume generation logic
- ATS DOM selector logic
- low-level browser extension field mapping

Those responsibilities belong to Components 1, 2, and 3 respectively.

## Proposed Stages

### Stage 0 : contract and boundaries

- define the orchestration boundary
- define what C4 may assume from C1, C2, and C3
- define which final actions require explicit policy

### Stage 1 : read-only orchestration view

- inspect component state without mutating it
- show whether a job is ready for downstream steps

### Stage 2 : trigger C3 intentionally

- choose a job
- call the shared apply-prep command
- invoke C3 autofill
- capture the resulting state

Expected inputs to that command:
- `job_id`

Expected resolved outputs:
- `apply_url`
- selected resume version id
- selected resume file path
- C3-ready context for that page/job

### Stage 3 : manual-review routing

- detect blocked or flagged flows
- route them to operator review instead of continuing blindly

### Stage 4 : submit policy

- define when submit is allowed
- make submit decisions explicit and reviewable

### Stage 5 : unattended runs

- add bounded scheduling
- add retry limits
- add notifications and summaries later

## Deployment Direction

Component 4 should deploy separately from Components 1, 2, and 3.

For now that likely means:
- OpenClaw on `server2`
- separate deployment/runtime docs
- separate operator controls from the C3 extension itself

## Related Docs

- `docs/components/component3/README.md`
- `docs/components/component3/design.md`
- `docs/components/component2/design.md`
- `docs/roadmap.md`
