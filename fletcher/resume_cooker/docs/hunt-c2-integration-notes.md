# Hunt C2/Fletcher Integration

Inventory revision: Hunt `9b8253d69d76950390755a532bd6219a08ad42ce`.

## Existing flow and insertion points

- `fletcher/pipeline.py::generate_resume_for_job` loads the queued job, runs `_run_pipeline`, records
  the attempt/version, and previously selected a ready result directly for C3.
- `fletcher/pipeline.py::_run_pipeline` produces `tex_path`, `pdf_path`, concern flags, attempt ID,
  version ID, and `selected_for_c3`.
- `fletcher/db.py::record_resume_attempt` persists attempts/versions and mirrors the selected paths
  into `jobs.selected_resume_*`.
- `coordinator/service.py::OrchestrationService._decision_from_row` requires
  `selected_resume_ready_for_c3`, version ID, and PDF path before C3 is ready.
- `coordinator/apply_prep.py::validate_apply_context` and `build_c3_payload` perform final selected
  resume validation before the extension receives an apply payload.
- Existing focused harnesses are `tests/test_component2_pipeline.py`,
  `tests/test_component4_c3_bridge.py`, and `tests/test_fletcher_queue_recovery.py`.

No reusable Resume Cooker subprocess/schema adapter existed. Fletcher concern flags were stored as a
single list, and no independent postflight report identity was part of readiness.

## Implemented boundary

`coordinator/resume_cooker.py` in Hunt owns:

- subprocess construction with no shell and hidden Windows process flags;
- timeout/cancellation and bounded, sanitized stream capture;
- schema-v1, command, status, run-ID, privacy, exit/report, and stdout/file-equivalence validation;
- D3 preflight and postflight policy;
- explicit actor/reason/timestamp override evidence;
- atomic decision records that retain the overridden report identity;
- separate `resume_cooker.*` and `fletcher.*` flags;
- disabled-by-default rollback behavior.

`generate_resume_for_job` now defers database selection when the gate is enabled. Only an accepted
postflight calls `fletcher/db.py::select_resume_version_for_c3`; a failed or missing gate cannot
leave C3 ready. Disabled mode uses the previous `_run_pipeline` selection path and invokes no Resume
Cooker process.

## Configuration and rollback

```text
HUNT_RESUME_COOKER_ENABLED=true
HUNT_RESUME_COOKER_COMMAND=resume-cooker
HUNT_RESUME_COOKER_TIMEOUT_SECONDS=120
HUNT_RESUME_COOKER_REPORT_ROOT=.state/resume_cooker
```

Local-only checks are the only implemented default. API mode is not enabled by a key and remains
authorization-gated. Set `HUNT_RESUME_COOKER_ENABLED=false` (or remove it) to roll back immediately;
the existing Fletcher path remains unchanged. Enabling in a deployed Hunt service is a separate
release decision and requires installing/configuring the package in that service environment.

Reports remain in ignored local state. No raw report, source, JD, or PDF is copied into this
repository's fixtures or hosted CI artifacts.

Only a completed report with a stable run identity can be overridden. Missing, timed-out,
cancelled, malformed, oversized, or unsupported responses remain fail-closed.
