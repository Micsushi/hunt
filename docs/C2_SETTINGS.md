# C2 Settings

C2 prompt and tailoring policy is configured from the Settings tab and persisted in
`component_settings` with `component='c2'`.

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
- `rewrite_examples`
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
