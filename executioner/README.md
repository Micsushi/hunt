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

### Account-access acceptance slice

After the accepted browser navigation capability is integrated, run the
bounded account-access checkpoint from a clean committed worktree:

```text
npm run live:s2 -- --config C:\private\s2-owner-inputs.json --stop-after account_access --evidence-root C:\private\s2-evidence
```

The runner verifies the exact checked-out Git SHA and rejects tracked, staged,
or untracked production changes before browser creation. At the account-access
checkpoint it inspects only the scoped account handle; the admitted Gmail
reference and its future record remain untouched until the mailbox-verification
lane. It proves account field entry, closes the owned browser with an
independent cleanup signal, and then atomically writes a value-free
`acceptance.json`. The recorded
`submitActivated: false` refers only to final job-application Submit; account
Create or Sign In is activated as part of account-access proof.

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
  "contractRevision": "s2-gmail-bootstrap-v2",
  "revisionId": "revision_...",
  "journeyId": "journey_...",
  "gmailHandleId": "secret_handle_...",
  "desktopClientId": "...apps.googleusercontent.com",
  "installedClientConfigPath": "C:\\absolute\\protected\\google-installed-client.json",
  "verificationHost": "wd5.myworkday.com"
}
```

Use an owner-approved Google Desktop OAuth client JSON with Gmail API access.
Keep that regular, bounded file outside every repository under a protected
current-user ACL. The bootstrap file contains only its canonical absolute path
and expected client ID; never copy the client secret into the bootstrap file,
arguments, environment, logs, or Node configuration. Enter only the verification
link hostname, never the full link or token. Then run:

```text
npm run provision:s2-gmail -- --config C:\absolute\external\f2-owner-inputs.json --gmail-bootstrap C:\absolute\external\gmail-bootstrap-input.json
```

All path, ACL, and exact-handle checks finish before a browser or prompt. Node
sees the canonical client-file path and expected client ID but never reads the
client JSON. The trusted Windows child is its sole content reader: it accepts
only the exact installed-client shape, matching client ID, pinned Google
endpoints, bounded loopback redirects, and a bounded secret. The child uses the
secret only in the token exchange, alongside an ephemeral IPv4 loopback
callback, PKCE S256, and only `gmail.readonly`. It confirms the Gmail profile matches the
DPAPI-protected Workday email and asks for the exact lowercase sender. OAuth,
mailbox, sender, and bundle values stay in that child; Node receives only DPAPI
CurrentUser ciphertext. Recreate both short-lived handles instead of mixing F1
and F2 expiry values. This command does not query Gmail or consume the message.

| Value | Bootstrap/Node owner | Trusted Windows helper owner | Durable output |
| --- | --- | --- | --- |
| expected desktop client ID | exact equality input | exact equality check | none |
| installed-client canonical path | admission and ACL only | bounded file open | none |
| installed-client JSON and client secret | none | sole reader; token form only | none |
| Gmail access token and mailbox identity | none | OAuth/profile/bundle sealing | DPAPI ciphertext only |

### Mailbox-candidate acceptance slice

Run this only from the clean committed revision used to provision the short-lived
F2 handles:

```text
npm run live:s2 -- --config C:\private\f2-owner-inputs.json --stop-after mailbox_candidate --evidence-root C:\private\s2-evidence
```

The runner queries only `gmail-api-v1` through the scoped Gmail handle and an
exact trailing 60-minute window. Recipient, sender, tenant, target, and journey
remain independently bound. It passes only for one unexpired candidate, releases
the process-local verification artifact, and seals value-free evidence with
`messageBodyRetained: false`. It never launches the Workday browser or navigates
the verification link.

Tests use Node's built-in runner. Components may depend on shared contracts but
not on peer implementations or C3 v2 source.
