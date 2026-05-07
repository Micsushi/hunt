# C2 Settings

C2 prompt, provider, and tailoring policy are configured from the Settings page and
persisted in `component_settings` with `component='c2'`.

The Settings page is organized by component tab. C2 controls live under
`C2 Fletcher`, with separate panels for provider/runtime, notifications, and prompt
policy.

## Current Storage Contract

- UI-edited values are stored in the shared `component_settings` table with
  `component='c2'`.
- Environment variables remain fallback values for local scripts, deploys, and
  first boot.
- Runtime helpers read Settings first where the value is supported, then fall
  back to env/defaults.
- Secret settings are write-only/redacted in the Settings API. The UI can store
  provider keys, but read responses return `value: null` and `has_value: true`.
- Tests should set `HUNT_DB_PATH` explicitly when they need settings so a
  developer's local DB does not leak into test behavior.

Settings are the preferred home for operator-tunable C2 behavior. Future CLI
commands should write the same table rather than inventing a separate config
file.

## Provider And Runtime

These settings control C2 model routing and local runtime behavior:

- `llm_provider`: `heuristic`, `ollama`, `openai`, `openrouter`, `anthropic`, or `gemini`.
- `llm_model`: generic provider model override.
- `llm_timeout_sec`: generic timeout for provider abstraction calls.
- `cloud_llm_confirm`: must be enabled before cloud providers send resume/JD text off-machine.
- `openai_api_key`, `openrouter_api_key`, `anthropic_api_key`, `gemini_api_key`: secret values stored redacted by the settings API.
- `ollama_host`
- `ollama_model`
- `ollama_timeout_sec`
- `ollama_keep_alive`
- `bullet_rewrite_parallelism`
- `bullet_rewrite_min_available_mb`
- `bullet_rewrite_max_memory_pct`

Environment variables remain supported as fallback. UI settings take precedence for
the dynamic runtime helpers.

Provider routing remains fail-closed:

- Local/default: `heuristic` or `ollama`.
- Cloud providers: `openai`, `openrouter`, `anthropic`, and `gemini`.
- Cloud providers require both a key and explicit `cloud_llm_confirm` before
  resume/JD text can leave the machine.
- Fletcher never silently replaces a local provider with a cloud provider.

## Prompt Policy

These settings control Fletcher prompts and runtime guards:

- `job_metadata_role_families`
- `job_metadata_job_levels`
- `target_lane_policy`
- `unsupported_target_examples`
- `blocked_keywords`
- `keyword_keep_policy`
- `keyword_ignore_policy`
- `summary_keyword_policy`
- `skill_addition_policy`
- `summary_good_example`
- `summary_banned_phrases`
- `rewrite_strategy`
- `rewrite_keyword_fit_policy`
- `rewrite_bullet_policy`
- `rewrite_length_policy`
- `rewrite_action_keyword_policy`
- `default_target_title`

## Numeric Limits

These numeric settings are also user-editable in the Settings tab:

- `keyword_selection_max_keywords`: max extracted keywords to keep.
- `keyword_selection_min_words`: min words per extracted keyword in the extraction prompt.
- `keyword_selection_max_words`: max words per extracted keyword in the extraction prompt.
- `job_metadata_prompt_max_chars`: first job-description characters used for metadata fill.
- `job_metadata_min_confidence`: confidence threshold used by metadata and prompt policy.
- `skill_addition_limit`: max Technical Skills additions per resume.

If a setting is missing or invalid, Fletcher falls back to defaults in
`fletcher/job_metadata_settings.py`.

## Queue And Review Settings Boundary

Option B run history and queue state do not live in Settings. They live in
`fletcher_jobs` because they are operational records, not preferences.

Review packages also do not live in Settings. They are attempt artifacts under
the C2 runtime root and are resolved through opaque `review_id` values.
