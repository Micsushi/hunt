# resume_tailor

This directory is the repo home for Component 2.

It now contains the first working local implementation plus the supporting scaffolding:
- parser and renderer code around `main.tex`
- pipeline and CLI entrypoints
- DB helpers for attempt/version persistence and downstream resume selection
- controlled compile retry logic for the one-page gate
- `base_resumes/` for curated family-specific starting resumes
- `prompts/` for structured LLM prompt templates
- `schemas/` for JSON output contracts
- `templates/` for user-authored source material such as candidate facts and bullet libraries

Important notes:
- the OG resume remains `main.tex` at the repo root
- generated artifacts should live outside the repo on `server2`
- this folder is for source files and implementation code, not runtime output storage

Still planned:
- Ollama-backed prompt execution
- richer family-base resume curation
- richer review UI flows
