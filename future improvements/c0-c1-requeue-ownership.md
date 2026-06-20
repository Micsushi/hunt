# C0/C1 Requeue Ownership Boundary

## Problem

C0 can currently requeue jobs by writing queue state directly through C1 database helper code.

This means C0 can mark a job as pending even if the C1 HTTP service is down. C1 still has to be running later for the worker loop to notice the queue state and process the job.

## Tradeoff

Pro: C0 can do fast operator actions directly against the database.

Con: C0 knows C1 storage rules, so component ownership gets blurry. If requeue behavior changes in C1, C0 can become stale because it bypasses the C1 service boundary.

## Current Mental Model

```text
C0 direct DB write = operator edits queue state
C1 worker loop = eventually notices queue state and acts
```

## Future Improvement

Move job requeue behavior behind a C1-owned service endpoint, or define a shared queue-state contract that C0 and C1 both use intentionally.

The desired end state is that requeue rules have one clear owner, while C0 remains the human-facing control plane.

## Acceptance Notes

- C0 UI can still requeue jobs from the Jobs page.
- C1 owns or formally shares the requeue state transition rules.
- Failure behavior is explicit when C1 is unavailable.
- Tests cover the chosen ownership boundary.
