# coordinator (C4)

This directory is the repo home for C4 (Coordinator).

Current scope:
- orchestration and submit-control source for C4 (Coordinator)
- OpenClaw-oriented integration planning
- shared contract surfaces for C1/C2/C3 coordination

Current checkpoint:
- `config.py` resolves the Hunt DB path and the runtime artifact root
- `db.py` creates and migrates:
  - `orchestration_runs`
  - `orchestration_events`
  - `submit_approvals`
- `context.py` builds the shared C4 snake_case apply context plus the C3 camelCase apply-prep payload
- `service.py` now contains the staged C4 state machine:
  - readiness evaluation
  - apply-prep / run creation
  - fill request
  - fill result recording
  - manual-review routing
  - submit approvals
  - submit completion
  - scheduler `pick-next` / `run-once`
- first-round scaffold now also includes:
  - optional `browser_lane` metadata on runs and apply-prep artifacts
  - expanded JSON-schema contracts under `coordinator/schemas/`
  - broader unit coverage for readiness, transitions, and guardrails
  - `hunterctl` pass-through commands for the current C4 CLI surface
- `cli.py` exposes those flows as a repo-local CLI

Important notes:
- this folder is for source files and interface definitions, not runtime artifacts
- runtime state should live outside the repo checkout on `server2`
- C4 (Coordinator) should consume C1, C2, and C3 contracts rather than re-implementing them
- the current code compiles and `python -m coordinator.cli init-db ...` works, but the full C4 test pass has not been finished yet

Current CLI surface:
- `python -m coordinator.cli init-db`
- `python -m coordinator.cli ready --job-id <ID>`
- `python -m coordinator.cli ready-list`
- `python -m coordinator.cli summary`
- `python -m coordinator.cli apply-prep --job-id <ID>`
- `python -m coordinator.cli request-fill --run-id <RUN_ID>`
- `python -m coordinator.cli record-fill --run-id <RUN_ID> --result-json <PATH>`
- `python -m coordinator.cli resolve-review --run-id <RUN_ID> --decision continue|fail --approved-by <NAME>`
- `python -m coordinator.cli approve-submit --run-id <RUN_ID> --decision approve|deny --approved-by <NAME>`
- `python -m coordinator.cli mark-submitted --run-id <RUN_ID>`
- `python -m coordinator.cli pick-next`
- `python -m coordinator.cli run --job-id <ID>`
- `python -m coordinator.cli run-once`
- `python -m coordinator.cli run-status --run-id <RUN_ID>`
- `python -m coordinator.cli runs`
- `python -m coordinator.cli events --run-id <RUN_ID>`

Current `hunterctl` pass-throughs:
- shared seam: `hunter apply-prep <ID>`
- prefixed C4 helpers: `hunter c4-ready`, `hunter c4-ready-list`, `hunter c4-summary`, `hunter c4-run-status`, `hunter c4-runs`, `hunter c4-run-once`, and related `c4-*` review/submit commands

Checkpoint docs:
- `docs/components/component4/README.md`
- `docs/components/component4/design.md`
- `docs/components/component4/design.md` (includes implementation checkpoint section)
- `docs/components/component4/hunter-coordinator-plan.md`
- `docs/components/component4/hunter-coordinator-ops.md`
- `docs/components/component4/hunter-coordinator-research.md`
