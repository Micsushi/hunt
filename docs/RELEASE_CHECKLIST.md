# Hunt Release Checklist

Run these steps in order before considering a change deployed.

## 1. Local tests

```
python ci.py all
```

All tests and quality checks pass on both Windows and Linux.

## 2. Local smoke

Spin up the full local stack and verify the pipeline works end to end:

```
docker compose -f docker-compose.pipeline.yml --profile pipeline up --build -d
python scripts/run_local_smoke.py
```

Check the C0 dashboard at `http://localhost:18090`:

- Dashboard health cards show active DB, C1, and C2 state plus C3 v3 as planned
- Jobs page loads
- Operator status page shows all services up

Tear down when done:

```
docker compose -f docker-compose.pipeline.yml --profile pipeline down
```

## 3. Deploy to server2

```
# From repo root on Windows - see docs/SERVER2_DEPLOY.md for full runbook
python scripts/deploy_server2.py   # or the Ansible playbook
```

## 4. Server2 smoke

Run the server2 smoke scripts after deploy:

```
bash scripts/smoke_pipeline_compose.sh
```

Verify in the live dashboard:

- C0 dashboard loads, health cards green
- C1 scrape/enrich can be triggered from Ops page
- C4 controls and run queue absent while the component is paused

## 5. Update docs

- Record verified task progress and release evidence in the selected task tracker
- `docs/LOCAL_POSTGRES_SMOKES.md`: update if smoke procedure changed

## 6. Record operator guidance and task progress separately

When release work changes durable operator context, update the smallest relevant
repo-local document:

- `docs/ARCHITECTURE.md` for component responsibilities and interactions
- `AGENTS.md` for contributor commands and safe-change guidance
- the relevant component document for human behavior, workflow or configuration guidance

Keep newly discovered work, blockers, task status and release evidence in the
selected task tracker, not a second editable roadmap. In this setup that tracker
is Project Records; reading these operator instructions does not require access
to it. This checklist does not lift C4's pause, authorize submission or establish
acceptance of a separate C3 candidate.

---

If any step fails: fix it before proceeding. Do not skip steps.
