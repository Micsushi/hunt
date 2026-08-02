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

This is a separate short-window step before the `account_verified` checkpoint.
Do not edit an expired F1 owner file. Create a new F2 owner file that preserves
the journey, revision, and target but uses a new approval and preallocated
account and Gmail handles. Its
approval, account secret, and Gmail authorization must share one expiry no
more than 30 minutes after the planned F2 bootstrap. Provision the new account
handle first with the account command.

Create a bootstrap JSON file outside every repository with exactly these fields:

```json
{
  "schemaVersion": 1,
  "contractRevision": "s2-gmail-bootstrap-v3",
  "revisionId": "revision_...",
  "journeyId": "journey_...",
  "gmailHandleId": "secret_handle_...",
  "desktopClientId": "...apps.googleusercontent.com",
  "installedClientConfigPath": "C:\\absolute\\protected\\google-installed-client.json",
  "senderPolicyConfigPath": "C:\\absolute\\protected\\gmail-sender-policy.json",
  "verificationHost": "wd5.myworkday.com"
}
```

Create the sender-policy file at the configured path with exactly this stable,
owner-approved policy:

```json
{
  "schemaVersion": 1,
  "contractRevision": "s2-gmail-sender-policy-v1",
  "senderAddress": "notifications@example.com"
}
```

Use an owner-approved Google Desktop OAuth client JSON with Gmail API access.
Keep both referenced files regular, bounded, distinct, outside every repository,
and under protected current-user ACLs. The bootstrap file contains only their
canonical absolute paths and the expected client ID; never copy the client
secret or sender address into bootstrap arguments, environment, logs, or Node
configuration. Enter only the verification hostname in the bootstrap JSON,
never a full link or token. Then run:

```text
npm run provision:s2-gmail -- --config C:\absolute\external\f2-owner-inputs.json --gmail-bootstrap C:\absolute\external\gmail-bootstrap-input.json
```

All path, ACL, and exact-handle checks finish before the system browser opens.
Node sees only canonical paths and the expected client ID; it never reads either
referenced JSON file. The trusted Windows child is their sole content reader. It
accepts only the exact installed-client shape and one exact versioned lowercase
sender address, then binds that address into the current derived sender policy,
journey, recipient, and target bundle. There is no sender prompt. The child uses
the client secret only in the token exchange, alongside an ephemeral IPv4
loopback callback, PKCE S256, and only `gmail.readonly`. It confirms the Gmail
profile matches the DPAPI-protected Workday email. OAuth, mailbox, sender, and
bundle values stay in that child; Node receives only DPAPI CurrentUser
ciphertext. Recreate both short-lived handles instead of mixing F1 and F2 expiry
values. This command does not query Gmail or consume the message.

The first bootstrap for an exact desktop client and normalized Gmail account
requests offline access with explicit consent and requires Google to return a
refresh grant. After the profile email matches, the trusted child stores that
grant as a bounded Generic Credential for the current Windows user. Its target
contains only a versioned SHA-256 binding of the client ID, normalized email, and
exact `gmail.readonly` scope; it contains no raw email. The grant is limited to
512 UTF-8 bytes. It also stores a separate durable lookup under an opaque
SHA-256 binding of the client ID and recipient binding. That lookup contains
only the 64-character grant locator. Later bootstraps for the same binding
refresh silently and do not open a browser. A missing grant starts the consent flow, but a malformed, revoked,
rejected, or wrong-scope existing grant fails as `gmail_refresh_grant_invalid`
with no same-attempt interactive fallback. A network or timeout failure, or HTTP
408, 429, or 5xx, fails as `gmail_refresh_unavailable`; it preserves the stored
grant and permits a separately initiated later provisioning attempt, without
opening a browser in the failed attempt. The same classification applies when
that transient response occurs during the post-refresh Gmail profile check;
profile denial, malformed profile, or wrong mailbox identity instead keeps the
existing grant and returns `gmail_refresh_grant_invalid`. Neither failure deletes the grant. The
provider can invalidate a grant at any time, so `gmail_refresh_grant_invalid`
requires explicit deletion followed by a separately initiated bootstrap. The
operator can revoke the exact provider grant and its matching local credential
with the same protected owner and bootstrap files:

```text
npm run revoke:s2-gmail-grant -- --config C:\absolute\external\f2-owner-inputs.json --gmail-bootstrap C:\absolute\external\gmail-bootstrap-input.json
```

The command never opens a browser and needs neither active account/Gmail secret
records nor account bytes. Historical owner/bootstrap bindings plus current
path and ACL checks admit the operation. The trusted child validates the
installed client, resolves the durable lookup to the exact grant, and posts
only that grant to Google's exact HTTPS revocation endpoint. It clears grant
bytes and deletes both the exact grant and lookup only after HTTP success or
the exact provider `invalid_token` response. A missing lookup is idempotent
success. Malformed or missing paired state is invalid and cleaned. Network and
timeout failures, HTTP 408, 429, and 5xx return `gmail_refresh_unavailable` and
preserve both entries. Output is limited to the value-free revoked or absent
result.

| Value | Bootstrap/Node owner | Trusted Windows helper owner | Durable output |
| --- | --- | --- | --- |
| expected desktop client ID | exact equality input | exact equality check | none |
| installed-client canonical path | admission and ACL only | bounded file open | none |
| installed-client JSON and client secret | none | sole reader; token form only | none |
| sender-policy canonical path | admission and ACL only | bounded file open | none |
| sender address | none | sole reader; current bundle binding | DPAPI ciphertext only |
| Gmail access token and mailbox identity | none | OAuth/profile/bundle sealing | DPAPI ciphertext only |
| Gmail refresh grant | none | OAuth refresh, revocation, and Windows Credential Manager only | current-user Generic Credential, maximum 512 bytes, under a scope-bound opaque target |

### Mailbox-candidate acceptance slice

Run this only from the clean committed revision used to provision the short-lived
F2 handles:

```text
npm run live:s2 -- --config C:\private\f2-owner-inputs.json --stop-after mailbox_candidate --evidence-root C:\private\s2-evidence
```

The runner queries only `gmail-api-v1` through the scoped Gmail handle across an
exact trailing 24-hour window. It holds the lower query bound at start minus 24 hours, advances the upper bound per
attempt, and uses a fresh query ID and provider instance on every attempt. F9
polls for at most 60 seconds and never beyond approval expiry, backing off from
250 milliseconds to at most 5 seconds. It retries only exact zero-candidate and
approved availability outcomes; ambiguity, non-retryable failures, and final
exhaustion remain exact. Recipient, sender, tenant, target, and journey remain
independently bound. It passes only for one unexpired candidate, releases the
process-local verification artifact, and seals value-free evidence with
`messageBodyRetained: false`. It never launches the Workday browser or navigates
the verification link.

### Account-verified acceptance slice

Provision both active secret handles before running this checkpoint:

```text
npm run live:s2 -- --config C:\private\f2-owner-inputs.json --stop-after account_verified --evidence-root C:\private\s2-evidence
```

The runner inspects both handles before browser creation. The lifecycle first
observes the page. An application-ready page is a no-op and a verification page
enters verification. Existing-account intent signs in, while fresh-create intent
switches to Create Account and creates first even when Workday defaults to the
Sign In page. Ordinary sign-in rejection never implies account absence. If
create returns the exact private `account_exists` fact, the lifecycle
independently observes it and switches once to sign-in. This prevents an
ambiguous sign-in error from blocking first-time signup while still preventing
duplicate account creation.

Tests use Node's built-in runner. Components may depend on shared contracts but
not on peer implementations or C3 v2 source.
