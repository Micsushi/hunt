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

### Account secret bootstrap

Keep the completed owner input JSON outside every repository and worktree, then
run the account-only provisioner from this directory:

```text
npm run provision:s2-account -- --config C:\absolute\external\owner-inputs.json
```

The command validates the frozen preflight and Windows ACL boundary before it
opens a secure Windows credential dialog. The dialog is the only place to enter
the Workday account email and password. Never pass the email or password
through arguments or environment variables. The trusted Windows child builds
the exact account bundle and DPAPI CurrentUser ciphertext before returning any
bytes to Node. The command writes only the preallocated opaque account handle,
rechecks its record ACL and metadata, and prints a value-free result. It does
not contact Workday or Gmail.

### Gmail authorization bootstrap

This is a separate short-window step after the fresh-account run stops at
`verification_required`. Do not edit the F1 owner file. Create a new F2 owner
file that preserves the journey, revision, and target but uses a new approval
and preallocated account and Gmail handles. Its
approval, account secret, and Gmail authorization must share one expiry no
more than 30 minutes after the planned F2 bootstrap. Provision the new account
handle first with the account command.

Manually inspect the new verification email. Create a second JSON file outside
every repository with exactly these fields:

```json
{
  "schemaVersion": 1,
  "contractRevision": "s2-gmail-bootstrap-v1",
  "revisionId": "revision_...",
  "journeyId": "journey_...",
  "gmailHandleId": "secret_handle_...",
  "desktopClientId": "...apps.googleusercontent.com",
  "verificationHost": "wd5.myworkday.com"
}
```

Use an owner-approved Google Desktop OAuth client ID with Gmail API access. Do
not add a client secret. Enter only the verification link hostname, never the
full link or token. Then run:

```text
npm run provision:s2-gmail -- --config C:\absolute\external\f2-owner-inputs.json --gmail-bootstrap C:\absolute\external\gmail-bootstrap-input.json
```

All ACL and exact-handle checks finish before a browser or prompt. The trusted
Windows child uses the system browser, an ephemeral IPv4 loopback callback,
PKCE S256, and only `gmail.readonly`. It confirms the Gmail profile matches the
DPAPI-protected Workday email and asks for the exact lowercase sender. OAuth,
mailbox, sender, and bundle values stay in that child; Node receives only DPAPI
CurrentUser ciphertext. Recreate both short-lived handles instead of mixing F1
and F2 expiry values. This command does not query Gmail or consume the message.

Tests use Node's built-in runner. Components may depend on shared contracts but
not on peer implementations or C3 v2 source.
