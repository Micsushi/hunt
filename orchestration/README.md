# orchestration

This directory is the repo home for Component 4.

Current scope:
- orchestration and submit-control scaffolding
- OpenClaw-oriented integration planning
- shared contract surfaces for later C1/C2/C3 coordination

Important notes:
- this folder is for source files and interface definitions, not runtime artifacts
- runtime state should live outside the repo checkout on `server2`
- Component 4 should consume C1, C2, and C3 contracts rather than re-implementing them

Planned source layout:
- `cli.py`
- `models.py`
- `service.py`
- `schemas/`

Planned future additions:
- DB integration helpers for readiness and orchestration runs
- shared apply-prep implementation
- OpenClaw-facing local CLI/API bridge
- submit approval persistence

Related docs:
- `docs/components/component4/README.md`
- `docs/components/component4/design.md`
