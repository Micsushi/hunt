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

## Stage 2 real-run preflight

The owner input file belongs outside the repository and every worktree. Never
copy the owner input file into the repository. It contains one exact approved
Workday URL and identity, opaque profile and resume references, scoped secret
handles, owner approval, and three absolute current-user-only roots for runtime,
secrets, and evidence. The roots must exist, must not overlap, and must resolve
outside all repository and worktree roots supplied by the runner.

The dry preflight does not launch a browser, contact Gmail or Workday, or
resolve a secret. It admits only `windows-dpapi-current-user-v1` and
`gmail-api-v1`, a 24-hour crash-recovery lease, and a 30-day retention ceiling.
Account and Gmail handles must be separate and bound to the exact journey,
purpose, consumer, scope, and approval expiry. Its public report contains only
opaque IDs, provider IDs, policy numbers, and the approved host, tenant, and
posting dimension names. Raw URLs and filesystem paths remain in a private
in-memory runtime binding.

The private admission boundary verifies the runtime, secrets, and evidence
roots, the owner input file, and every existing secret record before any
browser can start. Each item must be owned by the current Windows user, use a
protected DACL, grant full control directly to that user, and grant no allow
access to a principal other than the current user or SYSTEM. Reparse targets,
inherited allows, shared Users or Everyone access, and unavailable or malformed
ACL inspection fail closed without exposing a path.

Verify the dry boundary before any live runner is assembled:

```text
npm test -- tests/live/preflight
```

After the accepted browser navigation capability is integrated, run the
bounded account-access checkpoint from a clean committed worktree:

```text
npm run live:s2 -- --config C:\private\s2-owner-inputs.json --stop-after account_access --evidence-root C:\private\s2-evidence
```

The runner verifies the exact checked-out Git SHA and rejects tracked, staged,
or untracked production changes before browser creation. It inspects both
scoped secret handles without resolving Gmail authorization, proves account
field entry, closes the owned browser with an independent cleanup signal, and
then atomically writes a value-free `acceptance.json`. The recorded
`submitActivated: false` refers only to final job-application Submit; account
Create or Sign In is activated as part of account-access proof.

Tests use Node's built-in runner. Components may depend on shared contracts but
not on peer implementations or C3 v2 source.
