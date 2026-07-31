# C3 v3

C3 v2 has been removed from `main`. C3 v3 is planned but not implemented.

The v2 source, fixtures, tests, and supporting tools remain available on:

- branch: `codex/c3-v2-backup-20260730`

That branch is the committed v2 baseline. The latest uncommitted closure work
is preserved separately and is indexed in the private project handoff. Both
sources are reference material only. C3 v3 must not import or execute v2.

## Current boundary

- C3 owns its local application journey and orchestration loop.
- C3 does not depend on C4; C4 is on hold.
- Workday is the only ATS planned through the first three stages.
- Every field mutation requires independent verification.
- Final Submit is outside C3 v3 scope.
- Unknown personal facts stop with `profile_answer_missing`.

Implementation begins only from an approved stage, feature, and task plan.
