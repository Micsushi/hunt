# Prompts

This folder contains prompt templates for future structured LLM calls.

Planned prompt flow:
1. role classification
2. keyword extraction
3. structured rewrite
4. page-fit retry

These prompts should always:
- preserve truth
- avoid changing immutable facts
- return structured output only

## External reference : career-ops takeaways

The following is **not** adopted Hunt behavior : it preserves prompt-level ideas from the older `career-ops` repo for future C2/C3 prompt work. Do not treat `career-ops` code or file layout as a Hunt dependency.

### C2-oriented ideas

- extract a compact set of JD keywords before rewriting
- classify the job into a coarse role family before tailoring
- choose the most relevant projects and bullets instead of trying to keep everything
- rewrite the professional summary last-mile to match the JD language while staying truthful
- reorder bullet emphasis by relevance to the JD
- inject JD vocabulary into existing truthful experience rather than inventing new claims
- keep the output ATS-friendly and structurally simple

Framing:
- prefer exact JD wording when it truthfully matches existing experience
- keep claims evidence-backed rather than adjective-heavy
- favor short, direct, recruiter-readable bullets over generic marketing language
- use a limited number of high-value keyword phrases instead of stuffing

Guardrails:
- never invent skills, metrics, or tools
- preserve factual source material as higher priority than stylistic optimization
- treat weak or noisy JDs as lower-confidence tailoring inputs
- keep one-page pressure explicit in the prompt

### C3-oriented ideas (generated answers)

- answer each visible form question using the best available context (selected resume, candidate facts, JD snapshot, prior answers for the same job)
- keep answers in a tone of selective interest rather than desperation
- prefer concrete proof points over claims like "I am passionate about"
- keep answers short by default, usually a few sentences
- reference one real detail from the company or JD when possible
- produce copy-paste-ready answers grouped by exact question text

Patterns for common questions:
- `Why this role?` : map one concrete requirement to one concrete proof point
- `Why this company?` : reference one specific company, product, mission, or team detail
- `Relevant project or experience` : pick one quantified or otherwise strong example
- `Why are you a fit?` : explain the intersection between the job's needs and the candidate's demonstrated work

Guardrails:
- generated answers should sound confident but not inflated
- low-confidence answers should still be useful, but flagged for review
- generated text should avoid banned punctuation or formatting rules required by C3
- generated answers should be stored with the exact question they answered

### Prompt style patterns worth reusing

- tell the model what source files or fields are the factual source of truth
- explicitly separate immutable facts, editable phrasing, and generated helper text
- require concise, specific output rather than broad persuasive prose
- prefer proof-point language (what was built, what problem it solved, what evidence supports it)
- make the prompt say what not to do, not just what to do

### Do not import directly

- `career-ops` file-based tracker and pipeline model
- `career-ops` apply workflow as a true autofill implementation
- `career-ops` resume flow as Hunt's final C2 source-of-truth design
- `career-ops` role archetypes or candidate framing without adaptation

Likely future touchpoints:
- prompt drafts in this folder and C2 runtime code
- C3 answer-generation docs under `executioner/`
- review-app or operator notes on generated-answer tone and constraints
