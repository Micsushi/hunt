# Resume Cooker Quality Gate

Hunt integrates Resume Cooker through `coordinator/resume_cooker.py`; it does not import Resume
Cooker internals. `fletcher.pipeline.generate_resume_for_job` runs local preflight before Fletcher,
postflight after final TeX/PDF artifacts, and selects a version for C3 only after accepted evidence.

The integration defaults disabled:

```text
HUNT_RESUME_COOKER_ENABLED=true
HUNT_RESUME_COOKER_COMMAND=resume-cooker
HUNT_RESUME_COOKER_TIMEOUT_SECONDS=120
HUNT_RESUME_COOKER_REPORT_ROOT=.state/resume_cooker
```

The adapter validates schema v1, command, run identity, status, privacy metadata, D7 exit agreement,
and stdout/report-file equivalence. Missing executable, timeout, cancellation, malformed output,
unsupported schema, oversized output, and mismatched exits fail closed when required. Captured
diagnostics are not persisted.

Default policy:

- preflight pass or warnings: Fletcher may run;
- preflight fail: block unless an explicit actor/reason/timestamp override is supplied;
- missing, timed-out, cancelled, malformed, or unsupported preflight: block and cannot be
  overridden because no completed report identity exists;
- postflight pass or warnings: eligible Fletcher output may become C3-ready;
- postflight fail: C3 is not ready unless an explicit postflight override applies;
- postflight error or missing artifacts: C3 is not ready and cannot be overridden;
- flags remain `resume_cooker.*` and `fletcher.*`;
- a key alone never enables API review.

Before C3 selection, every enabled decision is atomically recorded as `decision-<uuid>.json` under
the configured report root. The record contains report identities, readiness, namespaced flags,
privacy state, and any actor/reason/timestamp override, but not raw source, JD, PDF, or process
diagnostics.

Rollback: remove or set `HUNT_RESUME_COOKER_ENABLED=false`. Disabled mode invokes no adapter and
preserves the prior Fletcher behavior. Enabling the gate in a deployed service is a separate release
decision and requires a reachable packaged CLI in that service environment.
