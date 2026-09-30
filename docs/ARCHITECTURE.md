# Hunt architecture

This checkout contains the active C0, C1 and C2 components. C3 is not implemented
here; a separate candidate is not made available or accepted by this guide.
C4 remains paused, including deployment, polling, UI and agent-worker paths.
Existing release and concurrency holds still apply. Preparing or filling an
application does not authorize submission; final Submit remains outside C3's
scope.

## Components and interactions

- C0 combines the React frontend with the FastAPI backend. The backend is the
  API gateway; the frontend does not call component services directly.
- C1 (`hunter/`) discovers and enriches jobs. It can run through its CLI or
  service; C0 can trigger discovery/enrichment and inspect its queue.
- C2 (`fletcher/`) prepares resumes. Its pasted-job-description and job-linked
  workflows expose generation, review and progress through C0.
- C3's intended boundary is an independent local loop, without C4 or database
  credentials. Its [public status](../executioner/README.md) describes the
  boundary, not an installed runtime.

```text
Browser -> C0 API gateway -> shared database
                        -> C1 service
                        -> C2 service
```

Gateway routes use `/api/gateway/*`. C0 uses the shared database for jobs,
resumes and settings. Component integration goes through the gateway, not
direct component-to-component API calls. C0 with the database supports job
and resume browsing; C1 supplies discovery/enrichment and C2 resume preparation.
This describes responsibilities, not proof that any host is deployed or tested.

## Operating boundaries

LinkedIn is the priority discovery source. C1 labels Easy Apply for exclusion
from downstream external-apply automation. Jobs with `priority = 1` remain
manual-only. Windows and Linux paths have separate qualification needs.

Local/container deployment uses `python deploy.py` and
`docker-compose.pipeline.yml`; see [deployment targets](DEPLOY.md). Server2
automation is separately owned; use the [server2 runbook](SERVER2_DEPLOY.md).
Nothing in this guide authorizes deployment, provider actions or access-control
bypass.

Task status, acceptance and future work belong in the selected task tracker.
The former roadmap is retained in Project Records, not as a second current
progress board in this checkout.
