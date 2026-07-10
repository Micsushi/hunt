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

- Dashboard health cards all green (DB, C1, C2, C3, C4)
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
- C4 run queue visible

## 5. Update docs

- `docs/roadmap.md`: mark newly completed items
- `docs/LOCAL_POSTGRES_SMOKES.md`: update if smoke procedure changed

## 6. Record durable context in the repo

When release work changes durable operator context, update the smallest relevant
repo-local document:

- `docs/roadmap.md` for newly discovered or completed work
- `AGENTS.md` for architecture or command guidance needed by future agents
- the relevant component document for behavior, workflow, config, or blockers

---

If any step fails: fix it before proceeding. Do not skip steps.
