# C2 Keyword Summary Log Fixes Implementation Plan
> REQUIRED SUB-SKILL: Use superpowers:executing-plans.

Goal: Fix the remaining C2 quality issues from pipeline logs 6-10 without adding a deterministic invalid-keyword cleanup step.

Architecture: Keep keyword quality prompt-side. Repair text encoding before any C2 prompt sees the JD. Let RAG keep deciding routing, and make summary retries explicitly react to failed style checks.

Tech Stack: Python, pytest, Ruff, Ollama prompt contracts.

## Issue 1: Keyword Extraction Still Leaks Actual Job Titles

Files: Modify `fletcher/llm/llm_enrich.py`, `tests/test_llm_enrich_logger.py`.

- [x] Step 1: Write test proving the keyword prompt says actual job titles and role labels must not be returned as keywords.
- [x] Step 2: Run:
  `python -m pytest tests/test_llm_enrich_logger.py -q`
  Expected fail: prompt test does not find the stronger wording yet.
- [x] Step 3: Update `_keyword_selection_instructions()` with short hard wording:
  `Never return the actual job title, role title, seniority label, employment type, degree, or major as a keyword.`
  Keep useful work-area keywords such as `backend engineering` or `web-based development` when they are short and useful.
- [x] Step 4: Run:
  `python -m pytest tests/test_llm_enrich_logger.py -q`
  Expected pass.
- [ ] Step 5: Commit later with the rest of the batch.

## Issue 2: Mojibake Repair Does Not Catch Actual Logs

Files: Modify `fletcher/text_normalize.py`, `tests/test_ad_hoc_pipeline.py`.

- [x] Step 1: Write tests for actual strings seen in logs:
  `stratÃ©gies`, `donnÃ©es`, `tables de dÃ©cision`, `lâ\x80\x99interface`.
- [x] Step 2: Run:
  `python -m pytest tests/test_ad_hoc_pipeline.py -q`
  Expected fail: current repair does not fix these strings.
- [x] Step 3: Extend `repair_mojibake()` to repair both single-encoded and double-encoded UTF-8/Windows-1252 corruption. Keep it as ingestion hygiene, not keyword cleanup.
- [x] Step 4: Run:
  `python -m pytest tests/test_ad_hoc_pipeline.py -q`
  Expected pass.
- [x] Step 5: Verify with:
  `python -c "from fletcher.text_normalize import repair_mojibake; print(repair_mojibake('stratÃ©gies'))"`
  Expected output: `stratégies`.

## Issue 3: Summary Retry Repeats Banned Tone

Files: Modify `fletcher/ad_hoc_pipeline.py`, `fletcher/llm/llm_enrich.py`, `tests/test_ad_hoc_pipeline.py`, `tests/test_llm_enrich_logger.py`.

- [x] Step 1: Write test proving the first summary prompt strongly bans aspirational wording before any retry happens.
- [x] Step 2: Run:
  `python -m pytest tests/test_ad_hoc_pipeline.py tests/test_llm_enrich_logger.py -q`
  Expected fail: first prompt and retry feedback are not strong enough.
- [x] Step 3: Strengthen the first summary prompt:
  `Do not use phrases like eager to, seeking to, excited to, looking to, passionate about, motivated to, or hoping to. State what the candidate does, not what they want.`
- [x] Step 4: Change summary validation retry feedback to include exact failed reasons:
  `Remove banned tone: eager. Do not use seeking/apply/excited/eager/motivated phrasing. State capability directly.`
- [x] Step 5: Ensure `retry_reason` is logged when retry happens because of style.
- [x] Step 6: Run focused tests again.

## Issue 4: BA/Pricing Summary Positioning Is Still Generic

Files: Modify `fletcher/llm/llm_enrich.py`, `tests/test_llm_enrich_logger.py`.

- [x] Step 1: Write prompt test for data/BA/intern summary context.
- [x] Step 2: Run:
  `python -m pytest tests/test_llm_enrich_logger.py -q`
  Expected fail: prompt does not say technical analyst/data-heavy analyst positioning yet.
- [x] Step 3: Add compact role-context wording:
  The prompt already sends job title, role family, and level. Tell the model to position the candidate for that exact job title and level.
  For `role_family=data`, position as `technical analyst` or `data-focused analyst` when the title contains analyst, pricing, strategy, or business.
  For `job_level=intern`, use `student` or `intern-level` framing without eager language.
- [x] Step 4: Run focused tests.

## Issue 5: Role Titles Can Still Enter Summary Keywords

Files: Modify `fletcher/llm/llm_enrich.py`, `tests/test_llm_enrich_logger.py`.

- [x] Step 1: Write test for summary keyword filter prompt: exact candidate keywords include `Full Stack Developer`; prompt must say role titles are never summary keywords.
- [x] Step 2: Run:
  `python -m pytest tests/test_llm_enrich_logger.py -q`
  Expected fail if wording is not strict enough.
- [x] Step 3: Strengthen `filter_summary_keywords_with_ollama()` prompt:
  `Never include a job title or role label in included. The title is already given separately.`
- [x] Step 4: Run tests.

## Issue 6: Accepted Low-Value Rewrites

Files: Modify `fletcher/llm/llm_enrich.py`, `tests/test_llm_enrich_logger.py`.

- [x] Step 1: No change planned. Rewrites are acceptable when the added keyword makes sense in the sentence.
- [x] Step 2: Run:
  `python -m pytest tests/test_llm_enrich_logger.py -q`
  Expected pass with current rewrite behavior.

## Final Verification

- [x] Run:
  `python -m pytest tests/test_llm_enrich_logger.py tests/test_ad_hoc_pipeline.py -q`
- [x] Run:
  `python ci.py c2`
- [x] Run:
  `git diff --check`

## Execution Handoff

1. Inline Execution: implement this plan in this worktree.
2. Subagent-Driven: split prompt tests, mojibake repair, and summary retry work across agents.
