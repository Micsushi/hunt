# Component 2 : Resume Tailoring

## Goal

Generate a truthful, job-specific resume from a source LaTeX resume using the enriched job description from Component 1.

The desired output is:
- a job-specific LaTeX resume
- a compiled PDF
- a one-page result when possible
- a saved output in a dated or named directory without overwriting the source resume

## Desired Workflow

1. Load the enriched job description and candidate profile context.
2. Parse the source resume into structured sections:
   - Experience
   - Education
   - Skills
   - Projects
3. Run Pass 1 to extract required and preferred keywords from the job description.
4. Run Pass 2 to rewrite and reorder resume content around the job requirements.
5. Validate the model JSON before using it.
6. Render the updated resume back into LaTeX.
7. Compile LaTeX to PDF.
8. Check page count with `pdfinfo`.
9. If the result exceeds one page, reduce length using controlled retries.
10. Save the final resume for that job.

## Prompting Rules

Pass 1 should:
- extract the top required and preferred keywords or skills
- separate must-have from nice-to-have qualifications

Pass 2 should:
- mirror exact job-description terminology where appropriate
- avoid introducing untrue claims
- rewrite bullets in XYZ style when possible
- rank and drop less relevant bullets
- preserve standard section headings that match the input resume format
- return structured JSON only

If the resume exceeds one page:
- adjust spacing and margins first
- if still too long, re-prompt with explicit cutting order:
  - oldest jobs
  - least relevant bullets
  - education details

## Backend Plan

Default local backend:
- Ollama
- `qwen3:8b`

Optional API backend:
- Gemini via a flag such as `--api gemini`
- preferred model: `gemini-2.5-flash`

Shared expectations:
- structured JSON output only
- retry once on malformed JSON
- target context large enough to fit resume plus job description
- lower temperature for consistency

## Implementation Notes

Inputs:
- enriched job record from Component 1
- source resume in LaTeX
- optional candidate profile data and reusable facts

Outputs:
- per-job output directory
- intermediate JSON artifacts when useful
- final `.tex`
- final `.pdf`
- metadata describing compile status and page count

## Proposed Stages

### Stage 1 : source resume parsing

- parse the LaTeX resume into a structured representation
- define the JSON schema for the parsed resume
- preserve enough detail to reconstruct LaTeX safely

### Stage 2 : keyword extraction

- build Pass 1 prompt and schema
- validate the JSON result
- save extracted keywords with the job record

### Stage 3 : resume rewrite

- build Pass 2 prompt and schema
- generate a structured rewritten resume
- map the structured output back to the LaTeX template

### Stage 4 : compile and fit loop

- compile to PDF
- inspect page count
- retry with spacing and content cuts when needed
- stop when the resume fits or the retry budget is exhausted

### Stage 5 : output packaging

- store outputs by job and timestamp
- keep source resume immutable
- record metadata for later application automation

## Risks And Constraints

- overly aggressive rewriting can drift from truthful experience
- LaTeX regeneration can break formatting if the template is not preserved carefully
- one-page enforcement needs deterministic fallback rules
- low-quality job descriptions from Component 1 will weaken tailoring quality

## Dependency On Other Components

- depends on Component 1 for the enriched description and clean application metadata
- produces assets that Component 3 will upload or submit
