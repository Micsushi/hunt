# coordinator (C4) schemas

This folder holds JSON-schema contracts for C4 (Coordinator) payloads.

Current contracts:
- `apply_context.schema.json`
- `c3_apply_context.schema.json`
- `ready_job_decision.schema.json`
- `orchestration_event.schema.json`
- `orchestration_run.schema.json`
- `run_status.schema.json`
- `submit_approval.schema.json`

These schemas mirror the current local C4 checkpoint:
- readiness decisions
- apply-prep artifacts
- orchestration runs and events
- submit approvals

They are scaffolding contracts for the current local runtime, not a promise that all later
OpenClaw / C3 bridge payloads are finished.
