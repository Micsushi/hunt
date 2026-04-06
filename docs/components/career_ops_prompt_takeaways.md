# Career-Ops Prompt Takeaways

## Purpose

This note captures prompt-level takeaways worth preserving from the `career-ops` repo.

These are not treated as adopted Hunt behavior yet.
They are future reference material for later C2 and C3 prompt work.

Scope:
- keep only prompting patterns and framing ideas
- do not treat `career-ops` code or runtime shape as a direct Hunt dependency
- do not treat these notes as a replacement for Hunt's current component contracts

## Why Keep These Notes

`career-ops` has some useful prompt patterns for:
- turning a JD into a tailored resume rewrite plan
- generating concise application-form answers from prior context
- keeping generated text specific, grounded, and non-fluffy

Those ideas may be useful later even though Hunt should keep its own:
- DB and queue model
- C2 artifact/history model
- C3 extension architecture

## C2 Prompt Takeaways

Useful ideas for future resume-tailoring prompts:

- extract a compact set of JD keywords before rewriting
- classify the job into a coarse role family before tailoring
- choose the most relevant projects and bullets instead of trying to keep everything
- rewrite the professional summary last-mile to match the JD language while staying truthful
- reorder bullet emphasis by relevance to the JD
- inject JD vocabulary into existing truthful experience rather than inventing new claims
- keep the output ATS-friendly and structurally simple

Useful framing rules:

- prefer exact JD wording when it truthfully matches existing experience
- keep claims evidence-backed rather than adjective-heavy
- favor short, direct, recruiter-readable bullets over generic marketing language
- use a limited number of high-value keyword phrases instead of stuffing

Useful guardrails:

- never invent skills, metrics, or tools
- preserve factual source material as higher priority than stylistic optimization
- treat weak or noisy JDs as lower-confidence tailoring inputs
- keep one-page pressure explicit in the prompt

## C3 Prompt Takeaways

Useful ideas for future generated-answer prompts:

- answer each visible form question using the best available context:
  - selected resume
  - candidate facts
  - JD snapshot
  - prior generated answers for the same job
- keep answers in a tone of selective interest rather than desperation
- prefer concrete proof points over claims like "I am passionate about"
- keep answers short by default, usually a few sentences
- reference one real detail from the company or JD when possible
- produce copy-paste-ready answers grouped by exact question text

Useful answer patterns:

- `Why this role?`
  - map one concrete requirement to one concrete proof point
- `Why this company?`
  - reference one specific company, product, mission, or team detail
- `Relevant project or experience`
  - pick one quantified or otherwise strong example
- `Why are you a fit?`
  - explain the intersection between the job's needs and the candidate's demonstrated work

Useful guardrails:

- generated answers should sound confident but not inflated
- low-confidence answers should still be useful, but flagged for review
- generated text should avoid banned punctuation or formatting rules required by C3
- generated answers should be stored with the exact question they answered

## Prompt Style Notes Worth Reusing

Patterns from `career-ops` worth carrying forward:

- tell the model what source files or fields are the factual source of truth
- explicitly separate:
  - immutable facts
  - editable phrasing
  - generated helper text
- require concise, specific output rather than broad persuasive prose
- prefer proof-point language:
  - what was built
  - what problem it solved
  - what evidence supports it
- make the prompt say what not to do, not just what to do

## What Not To Import Directly

These notes should not be read as approval to import the following as-is:

- `career-ops` file-based tracker and pipeline model
- `career-ops` apply workflow as a true autofill implementation
- `career-ops` resume flow as Hunt's final C2 source-of-truth design
- `career-ops` role archetypes or candidate framing without adaptation

## Likely Future Use

Most likely later touchpoints:

- C2 prompt drafts under `resume_tailor/prompts/`
- C3 answer-generation prompt or helper docs under `apply_extension/`
- future review-app or operator notes that explain generated-answer tone and constraints
