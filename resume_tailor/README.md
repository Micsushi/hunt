# resume_tailor

This directory is the repo home for Component 2.

It currently contains scaffolding only:
- `base_resumes/` for curated family-specific starting resumes
- `prompts/` for structured LLM prompt templates
- `schemas/` for JSON output contracts
- `templates/` for user-authored source material such as candidate facts and bullet libraries

Important notes:
- the OG resume remains `main.tex` at the repo root
- generated artifacts should live outside the repo on `server2`
- this folder is for source files and implementation code, not runtime output storage

Planned future additions:
- parser and renderer code
- CLI entrypoints
- tests
- DB integration helpers

