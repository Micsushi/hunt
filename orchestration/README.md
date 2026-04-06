# orchestration

This directory is the repo home for Component 4.

Current scope:
- orchestration and submit-control source for Component 4
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
- `cli.py` exposes those flows as a repo-local CLI

Important notes:
- this folder is for source files and interface definitions, not runtime artifacts
- runtime state should live outside the repo checkout on `server2`
- Component 4 should consume C1, C2, and C3 contracts rather than re-implementing them
- the current code compiles and `python -m orchestration.cli init-db ...` works, but the full C4 test pass has not been finished yet

Current CLI surface:
- `python -m orchestration.cli init-db`
- `python -m orchestration.cli ready --job-id <ID>`
- `python -m orchestration.cli summary`
- `python -m orchestration.cli apply-prep --job-id <ID>`
- `python -m orchestration.cli request-fill --run-id <RUN_ID>`
- `python -m orchestration.cli record-fill --run-id <RUN_ID> --result-json <PATH>`
- `python -m orchestration.cli resolve-review --run-id <RUN_ID> --decision continue|fail --approved-by <NAME>`
- `python -m orchestration.cli approve-submit --run-id <RUN_ID> --decision approve|deny --approved-by <NAME>`
- `python -m orchestration.cli mark-submitted --run-id <RUN_ID>`
- `python -m orchestration.cli pick-next`
- `python -m orchestration.cli run --job-id <ID>`
- `python -m orchestration.cli run-once`
- `python -m orchestration.cli run-status --run-id <RUN_ID>`

Checkpoint docs:
- `docs/components/component4/README.md`
- `docs/components/component4/design.md`
- `docs/components/component4/implementation_checkpoint.md`
