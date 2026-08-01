# C3 v3

C3 v3 Stage 1 implements one local, controlled Workday fixture journey. It
wires the accepted components through the F9 journey loop, independently
verifies required fields, reaches mock Review, and stops without Submit.

This is local Tier 2 evidence only. It has not been merged to `main`, run by
hosted CI, deployed, or exercised against a live Workday account.

## Local Stage 1 verification

Run from the repository root on one clean commit:

```text
npm --prefix executioner ci
npm --prefix executioner test -- tests/architecture tests/acceptance/components tests/connections tests/acceptance/s1 tests/security/privacy
npm --prefix executioner run quality
node executioner/scripts/run-s1-acceptance.ts
python ci.py c3
```

`python ci.py all` preserves the existing Hunt checks and tests, then runs the
same Executioner clean install and quality gate. See
[Stage 1 local verification](docs/s1-verification.md) for the recorded outcomes,
report contract, and S2 handoff.

## Historical reference

C3 v2 has been removed from `main` and must not be imported or executed by v3.
Its source, fixtures, tests, and supporting tools remain available on branch
`codex/c3-v2-backup-20260730` as reference material only.

## Current boundary

- C3 owns its local application journey and orchestration loop.
- C3 does not depend on C4; C4 is on hold.
- Stage 1 uses controlled Workday fixtures only.
- Every field mutation requires independent verification.
- Final Submit is outside C3 v3 scope.
- Unknown personal facts stop with `profile_answer_missing`.

Tests use Node's built-in runner. Components may depend on shared contracts but
not on peer implementations or C3 v2 source.
