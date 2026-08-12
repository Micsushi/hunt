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

Future C1 synchronization for maintenance, runtime-error, and removed-posting statuses is
specified in [the C1/C3 job-status handoff](docs/c1-c3-job-status-handoff.md).
C3 currently emits the typed factual outcome only; it does not mutate C1.

## Future Chrome extension delivery

The current C3 v3 browser adapter owns a Playwright-launched Chrome session. A
Chrome extension is not required for the accepted implementation, but it is a
candidate future delivery surface when C3 must operate inside a user's existing
desktop Chrome session or be controlled from another device.

Two future modes are intentionally preserved for evaluation:

- Replace the Playwright adapter with a Chrome extension that inspects and
  acts on the user's current Workday tab.
- Keep the C3 orchestration service and add a paired desktop extension as the
  browser-side executor. The server would choose bounded actions, while the
  extension would perform them in the current tab. A local service could retain
  resumes, profile values, secret handles, and file-upload authority so raw
  private data does not need to pass through the remote server.

Either mode requires a separate threat model and acceptance contract covering
device pairing, authenticated encrypted transport, origin and tab scoping,
reconnection, extension permissions, private-data boundaries, file uploads,
MFA and CAPTCHA handoff, and visible operator control. This is a future option,
not implemented or activated by the current package. It does not change the
existing prohibition on final Submit.

## Stage 2 real-run preflight

The owner input file belongs outside the repository and every worktree. Never
copy the owner input file into the repository. It contains one exact approved
Workday URL and identity, opaque profile and resume references, scoped secret
handles, owner approval, and three absolute current-user-only roots for runtime,
secrets, and evidence. The roots must exist, must not overlap, and must resolve
outside all repository and worktree roots supplied by the runner.

The dry preflight does not launch a browser, contact Gmail or Workday, or
resolve a secret. It admits only `windows-dpapi-current-user-v1` and
`gmail-api-v1`, an approval-bounded live authority, and a 30-day retention ceiling.
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

For a fresh run that reuses the already approved pinned account source, call the
same provisioner with the protected source path and its current digest:

```powershell
$accountSource = 'C:\private\hunt-account.env'
$accountSourceSha = (Get-FileHash -Algorithm SHA256 -LiteralPath $accountSource).Hash.ToLowerInvariant()
npm run provision:s2-account -- --config C:\absolute\external\owner-inputs.json --env-source $accountSource --sha256 $accountSourceSha
```

This path opens no credential dialog. The trusted Windows child verifies the
exact source bytes, extracts only the two pinned account keys, and emits only
journey-scoped DPAPI ciphertext. The plaintext values never enter Node,
arguments, output, or the new run storage.

### Account-access acceptance slice

After the accepted browser navigation capability is integrated, run the
bounded account-access checkpoint from a clean committed worktree:

```text
npm run live:s2:slice -- --config C:\private\s2-owner-inputs.json --stop-after account_access --evidence-root C:\private\s2-evidence
```

On Windows, every headed live run requires a non-primary monitor. `live:s2:slice`
starts the entire acceptance runner inside a kill-on-close Windows Job on a
named, non-switched desktop; Playwright and its owned Chrome descendants inherit
that desktop. The browser launcher independently attests the desktop binding,
stores the window inside the rightmost secondary monitor, minimizes it without
activation, and verifies the minimized DPI-equivalent bounds through the owned
persistent context. It never switches the desktop, restores, activates, brings
the page forward, or attaches to an externally launched browser. Closing the
Job owns cleanup for the runner and every browser descendant, including parent
cancellation. Missing secondary geometry, failed isolation, or a browser that
restores itself fails closed before the job flow continues.

The runner verifies the exact checked-out Git SHA and rejects tracked, staged,
or untracked production changes before browser creation. At the account-access
checkpoint it inspects only the scoped account handle; the admitted Gmail
reference and its future record remain untouched until the mailbox-verification
lane. It proves account field entry, closes the owned browser with an
independent cleanup signal, and then atomically writes a value-free
`acceptance.json`. Every admitted account-access run, including target facts and
stable failures, attempts to seal `diagnostics.json` after cleanup; a persistence
failure becomes the explicit `evidence_unavailable` terminal error. That file contains the
ordered component/phase/step `EventEnvelope` records, cleanup state, and the
exact `TerminalResult` for blocked or failed
runs. It contains no URL, selector, page text, account value, credential,
mailbox value, or raw browser capture. Factual outcomes print as `blocked`, not
`failed`.

`createStage2DiagnosticsMcpFromEvidenceRoot(...)` composes the protected
evidence reader with the read-only Stage 2 MCP facade. Existing MCP request v2
`journey_status` and `journey_result` calls return response v4 progress or the
sealed terminal fact when diagnostics are available. Start, cancel, raw browser actions, and evidence-root
paths are not exposed by this readback facade.

The recorded
`submitActivated: false` refers only to final job-application Submit; account
Create or Sign In is activated as part of account-access proof.

### Stage 2 run storage lifecycle

Do not invent or remember evidence-folder IDs for new runs. Prepare a complete
run from one protected storage root, the exact Workday URL, and the account
intent:

```text
npm run prepare:s2-run -- \
  --storage-root C:\private\hunt-c3-storage \
  --target-url https://tenant.wd5.myworkdayjobs.com/en-US/Careers/job/Title_R12345 \
  --account-mode sign_in \
  --application-profile C:\private\hunt-c3-inputs\application-profile.json \
  --application-resume C:\private\hunt-c3-inputs\application-resume.pdf
```

The two application-source arguments are required for a full application and
Review journey. They are read from protected absolute paths outside the
repository, copied and hash-bound before approval, and never returned by the
command. Omitting both retains the account-only preparation mode used by
diagnostics and recovery tooling; it cannot authorize application filling.

The command parses the target, generates every run-scoped ID, writes the owner
configuration, applies a protected Windows ACL for only the current user and
SYSTEM, and returns the exact paths needed by later commands. Callers cannot
supply a run, journey, target, secret, or approval ID. The generated layout is
deliberately physical:

```text
hunt-c3-storage/
  bindings/
    recipient-binding.json
    verification-consumption/<opaque-claim>.json
  transient/<internal-run-key>/
    owner-input.json
    runtime/
    secrets/
  retained/<internal-run-key>/
    evidence/
  retained/catalog.json
```

`bindings` contains one protected opaque recipient identity reused for later
Gmail authorization and delayed-message recovery, plus 30-day opaque
verification-consumption claims that prevent the same provider artifact from
being opened again after a restart. It contains no email address, provider
message ID, subject, body, company, posting, URL, URL hash, or token. `transient`
contains everything that goes: the owner
configuration, run-scoped IDs, scoped secret records, browser/runtime state,
and crash-recovery material. `retained` contains only sanitized evidence that
stays for the approved 30-day retention window. The job host, tenant, posting,
observed outcome, completion time, source revision, evidence hashes, and expiry
are recorded in a catalog, so operators never need to remember a journey ID,
folder ID, or still-live job URL.

After the bounded run is finished, independently monitored, process-clean, and
has a passing `completion-audit.json`, close its storage lifecycle:

```text
npm run storage:s2 -- finalize --storage-root C:\private\hunt-c3-storage --config C:\private\hunt-c3-storage\transient\...\owner-input.json --evidence-root C:\private\hunt-c3-storage\retained\...\evidence
```

Finalization fails closed unless the config, transient roots, retained root,
target, process audit, completion audit, privacy result, and Submit=false result
all agree. Only then does it remove the exact transient run tree, seal a
`storage-manifest.json` plus `disposal-audit.json`, and add the run to the
catalog. It never deletes another run or a shared parent.

If a run never produced a completion audit, discard only that exact unfinished
layout with the same three bound paths:

```text
npm run storage:s2 -- discard --storage-root C:\private\hunt-c3-storage --config C:\private\hunt-c3-storage\transient\...\owner-input.json --evidence-root C:\private\hunt-c3-storage\retained\...\evidence
```

Discard refuses completed or cataloged evidence, validates both trees before
deletion, and removes only the bound transient and unfinished retained run.

Inventory all managed runs by lifecycle disposition, list retained history,
rebuild a lost catalog solely from sanitized retained manifests, or remove only
evidence whose 30-day deadline has passed:

```text
npm run storage:s2 -- inventory --storage-root C:\private\hunt-c3-storage
npm run storage:s2 -- list --storage-root C:\private\hunt-c3-storage
npm run storage:s2 -- rebuild --storage-root C:\private\hunt-c3-storage
npm run storage:s2 -- sweep --storage-root C:\private\hunt-c3-storage
```

`inventory` is read-only and labels exact managed runs as retained/finalized,
ready to finalize, unfinished and eligible for exact discard, legacy retained,
or invalid for manual review. Existing historical evidence is left in place so
recorded paths and handoffs do not break; inventory never migrates or deletes it.

`storage:s2 -- prepare` remains the lower-level allocator for tests and manual
recovery tooling. Normal live work uses `prepare:s2-run` so the durable binding
cannot be replaced by a disposable per-job value.

### Same-revision Stage 2 Review acceptance

Use `live:s2` only for the approved final Stage 2 journey. It accepts the exact
prepared run layout, and `--stop-after review` is the only checkpoint:

```text
npm run live:s2 -- --config C:\private\hunt-c3-storage\transient\<run>\owner-input.json --stop-after review --evidence-root C:\private\hunt-c3-storage\retained\<run>\evidence
```

The command first captures the production source revision and a SHA-256 digest
plus opaque IDs from the owner config. It runs `npm run quality`, recaptures
both inputs, runs the real journey in the isolated process boundary, and
recaptures both inputs again. It accepts only an exact sanitized Review packet
with independent Review proof, structural Submit presence,
`submitActivated: false`, and `privacyScan: pass`. A pass writes
`application-walk-acceptance.json` for the page walk,
`review-acceptance.json` for the Review gate, and
`s2-acceptance-manifest.json`, finalizes only the bound run, removes only its
transient tree, and records the disposal audit. Final job Submit remains
forbidden and is not exposed by this command or the real runner.

Inside the isolated boundary, the owned browser session constructs one fixed
Workday runtime before effects; callers provide data only and cannot inject a
raw-page callback. Before browser ownership, any recovery artifact must match
the exact source revision, config digest, approval, journey, target handle, and
target identity in both its outer scope and embedded checkpoint. Resume and
every later verified page are checkpointed. After an interruption, an immediate
one-page browser advance may be reconciled even when that destination is still
incomplete; skips, regressions, and unverified persisted prefixes are denied.
Reconciled browser truth and its complete verified prefix are persisted as the
exact resumable cursor, including across a second restart.
This bounded recovery leads only into verified pre-Review page checks and
independent Review proof. The Review Stopper admits only a complete non-empty
set of stable row identities bound to the expected field IDs, provenance, and
value hashes. It observes only structural Submit presence and exposes no Submit
target or action. The privacy writer seals `real-evidence/manifest.json` before
browser cleanup. The acceptance record is durably written before terminal
recovery and profile cleanup; a failed evidence or acceptance write retains the
exact resumable checkpoint. The outer gate then reconciles that file against
the captured revision and config, writes the acceptance manifest, and finalizes
the exact prepared run.

The accepted immutable owner-source resolver is concrete in this composition.
It captures the protected config, profile plan, configured narrative, and
single-use resume snapshot, then binds them to the same source, revision,
approval, journey, target, and opaque references. A concrete Playwright
application, recovery, and Review runtime adapter is bound by production. It
owns one page, exposes only closed non-Submit operations, independently verifies
exact Review field, value, and provenance bindings for the admitted dotted
field-ID grammar, and revokes owner-source access on failed open and during
cleanup.
After terminal acceptance, suspension, normal close, or failed cleanup, the
returned runtime retains only the value-free binding primitives needed by its
closed ports, not the raw owner-source graph.
Real proof is still owner-input blocked until the operator supplies an approved
current owner config, immutable profile and resume sources, a valid account and
session, and a protected evidence destination. Do not replace those inputs with
raw values, paths, environment secrets, or a permissive fallback. Tier 2
deterministic composition tests do not claim a real account acceptance run.

The gate stops on the first failed phase. Stable failures include
`quality_failed`, `source_changed`, `config_changed`, `runtime_binding_failed`,
`real_journey_failed`, `result_reconciliation_failed`, and
`cleanup_finalize_failed`. Cancellation returns `operation_cancelled`. A
failure never automatically discards evidence or another run. Inspect the
layout with `npm run storage:s2 -- inventory --storage-root <root>`, reconcile
the exact retained and transient paths, and use `storage:s2 -- discard` only
when inventory proves that exact run is unfinished. Do not rerun into the same
layout. Prepare and provision a new prepared run, then repeat the one command
with its new config and evidence paths.

The lower checkpoints remain available as `live:s2:slice` for bounded F1/F2
diagnostics. A slice is not the Stage 2 acceptance gate and cannot certify
Review.

For the production four-method MCP transport, bind stdio to one already
prepared run with the same three out-of-band arguments:

```text
npm run mcp:s2 -- --config C:\private\hunt-c3-storage\transient\<run>\owner-input.json --stop-after review --evidence-root C:\private\hunt-c3-storage\retained\<run>\evidence
```

Only `start_journey`, `cancel_journey`, `journey_status`, and `journey_result`
are admitted on stdin. `start_journey` accepts only the exact opaque target,
resume, and profile references sealed by that owner config. Config paths,
target URLs, applicant values, browser objects, selectors, and final Submit
authority never enter the MCP wire. One journey runs in the background;
cancellation and stdio shutdown abort it and await owned cleanup. Input lines
are limited to 16 KiB. Replay state is capped at 256 requests, with the final
three entries reserved for exact-journey cancellation, terminal status, and
terminal result readback; invalid or wrong-journey requests cannot consume
those entries. Further requests fail closed. Factual terminals and verified
completed-page counts pass through unchanged from the journey.

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
  "senderPolicyConfigPath": "C:\\absolute\\protected\\gmail-company-policy.json",
  "verificationHost": "tenant.wd5.myworkdayjobs.com"
}
```

Create the company-policy file at the configured path with exactly this stable,
owner-approved policy:

```json
{
  "schemaVersion": 1,
  "contractRevision": "s2-gmail-company-policy-v1",
  "companyName": "Example Company",
  "verificationHost": "tenant.wd5.myworkdayjobs.com",
  "verificationTenant": "tenant"
}
```

The company policy is target-bound. Its host and tenant must exactly match the
current approved Workday target. The bootstrap field remains named
`senderPolicyConfigPath` for wire compatibility, but the referenced file is a
company policy; no sender allowlist is used. Gmail searches for the exact current
company within the preceding hour, then independently validates the exact
recipient, Workday tenant and target, HTTPS verification link, and unique result.

Use an owner-approved Google Desktop OAuth client JSON with Gmail API access.
Keep both referenced files regular, bounded, distinct, outside every repository,
and under protected current-user ACLs. The bootstrap file contains only their
canonical absolute paths and the expected client ID; never copy the client
secret or company policy contents into bootstrap arguments, environment, logs,
or Node configuration. Enter only the verification hostname in the bootstrap
JSON, never a full link or token. Then run:

```text
npm run provision:s2-gmail -- --config C:\absolute\external\f2-owner-inputs.json --gmail-bootstrap C:\absolute\external\gmail-bootstrap-input.json
```

All path, ACL, and exact-handle checks finish before authorization begins. C3
never opens, focuses, or controls a browser for Google consent. When interactive
consent is required, the trusted Windows child creates the protected one-time
`gmail-oauth-authorization.url` handoff beside the installed-client JSON and
waits for its loopback callback. The operator opens that file in a browser of
their choice, completes Google sign-in, MFA, and consent, and leaves the
provisioning command running. The child verifies that the parent directory has
the exact protected current-user ACL, creates the handoff with an exact
current-user-and-SYSTEM ACL, and never shares the file while writing it. Open it
promptly because the callback expires after 210 seconds. The handoff is deleted
after the callback, timeout, cancellation reconciliation, or other ordinary
failure. Do not copy, share, or log its contents. If a machine or process crash
still leaves a stale handoff, the next attempt fails distinctly as
`gmail_oauth_handoff_unavailable`. First confirm no Gmail bootstrap is running,
delete only that exact file, and retry.

Node sees only canonical paths and the expected client ID; it never reads either
referenced JSON file. The trusted Windows child is their sole content reader. It
accepts only the exact installed-client shape and one exact versioned company
policy, then binds that company into the current derived policy, journey,
recipient, and target bundle. There is no sender prompt. The child uses
the client secret only in the token exchange, alongside an ephemeral IPv4
loopback callback, PKCE S256, and only `gmail.readonly`. It confirms the Gmail
profile matches the DPAPI-protected Workday email. OAuth, mailbox, company, and
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
refresh silently and do not require a consent handoff. A missing grant starts
the consent flow, but a malformed, revoked,
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
| company-policy canonical path | admission and ACL only | bounded file open | none |
| company name | none | sole reader; current bundle binding | DPAPI ciphertext only |
| Gmail access token and mailbox identity | none | OAuth/profile/bundle sealing | DPAPI ciphertext only |
| Gmail refresh grant | none | OAuth refresh, revocation, and Windows Credential Manager only | current-user Generic Credential, maximum 512 bytes, under a scope-bound opaque target |

### Mailbox-candidate acceptance slice

Run this only from the clean committed revision used to provision the short-lived
F2 handles:

```text
npm run live:s2:slice -- --config C:\private\f2-owner-inputs.json --stop-after mailbox_candidate --evidence-root C:\private\s2-evidence
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

An account-verification poll remains bounded to five minutes. If an exact
message arrives later, prepare a fresh `sign_in` run under the same storage root
and provision its new Gmail handle. The stable opaque recipient binding resolves
the protected refresh grant silently, and the fresh query's trailing 24-hour
window can recover the delayed message. This is a new authorized continuation,
not an unbounded poll and not reuse of expired run authority. Exact recipient,
sender, tenant, host, and posting checks still fail closed on zero or multiple
candidates.

### Account-verified acceptance slice

Provision both active secret handles before running this checkpoint:

```text
npm run live:s2:slice -- --config C:\private\f2-owner-inputs.json --stop-after account_verified --evidence-root C:\private\s2-evidence
```

The runner inspects both handles before browser creation and classifies the
current page before every account decision. Fresh-create intent uses Create
Account first even when Workday defaults to Sign In. After account creation,
the observed page determines the next step:

- `application_ready` means signup authenticated the session and no login or
  email verification is required.
- `verification_required` starts the bounded Gmail verification path. The
  verification destination is classified again and may require one Sign In.
- a transition from Create Account to Sign In performs one Sign In and then
  requires an independently observed `application_ready` page.

The lifecycle emits only fixed page and action identifiers. If the fallback
returns toward Create Account or repeats verification instead of advancing, it
emits `lifecycle_cycle_stopped` and fails closed. It never creates again from
that fallback. An exact private `account_exists` fact may also switch once to
Sign In, while an ordinary sign-in rejection never implies account absence.

The isolated production runner now requires an ordinal external monitor gate
for every account or application mutation, readback, navigation, recovery, and
Review observation. Each request binds the live process, source, config, target,
operation, attempt, screenshot, sanitized taxonomy, and previous ACK. The
runner blocks the corresponding browser effect until the independent monitor
writes an exact ACK. The independent monitor supplies a protected version-2
`NNNN-page-moment.observation.json` containing its independently read host,
tenant, posting, and title, the retained screenshot digest, reviewed structural
IDs, and its observation time. The ACK writer derives identity digests itself
and rehashes the retained PNG; applicant values, selectors, and DOM content
never appear on the command line.

```text
npm run ack:s2-monitor -- --runtime-root C:\private\hunt-c3-storage\transient\...\runtime --evidence-root C:\private\hunt-c3-storage\retained\...\evidence --monitor-request C:\private\hunt-c3-storage\retained\...\evidence\monitor\0001-resume-before_mutation.request.json --classification safe_to_continue --observation C:\private\hunt-c3-storage\transient\...\runtime\0001-resume-before_mutation.observation.json
```

The final account-ready and Review-readback records use `account_verified` and
`review_verified`; all earlier records use `safe_to_continue`. Crossed, replayed,
late, malformed, missing, or post-close records are rejected. After the isolated Windows Job writes a
passing process audit, run `npm run audit:s2 -- --evidence-root ...`. The audit
now covers both `account_access` and `account_verified`. Account verification
records either one exact Gmail candidate consumed or a credential sign-in that
was independently re-observed at `application_ready`; it never reports one as
the other. Both proofs require cleanup, privacy, no retained message body, and
`submitActivated: false`.

Set `HUNT_C3_VALUE_FREE_ACCOUNT_TRACE=1` on a protected live runner to stream
JSON diagnostics to stderr. Monitor records include only the governed chain,
page, moment, ordinal, opaque operation ID, attempt, sanitized control/question/
answer taxonomy, Submit safety state, and a fixed failure stage. Application
walk records add verified page counts, canonical type/provenance summaries, and
the terminal blocker owner, classifier, primitive, and unknown layer. They do
not include labels, options, applicant values, credentials, URLs, DOM, paths,
or screenshots. Keep the redirected stderr file inside the run's protected
transient storage and remove it with the run artifacts.

Tests use Node's built-in runner. Components may depend on shared contracts but
not on peer implementations or C3 v2 source.

## Public Workday test catalogs

The repository root has two current Workday test CSVs:

- `wd_test_jobs.csv` contains exactly 100 unique companies and one public job
  per company. Each row was browser-verified through the Workday application
  entry on 2026-08-05 and stops before account or form interaction.
- `wd_test_jobs_stale.csv` contains 10 previously verified closed jobs. Use it
  only for stale, removed, and not-found behavior.

These live URL catalogs are independent of the accepted offline `WD40` corpus.
The historical bytes used to validate that frozen manifest are retained as the
non-CSV `corpus/workday-40/source.snapshot`, so refreshing public jobs does not
rewrite accepted Stage 3 evidence. That snapshot is lineage from ancestor
`16c48bd1470addc9d9480d785ae84e412edd55ef`, not a copy of the current public
catalog.

# Frozen corpus acceptance

The S3-F4 local acceptance workflow freezes one clean revision and its corpus
inputs, runs fixtures before a sequential 40-slot reconciliation, audits safety
and privacy gates, and builds an allowlisted local package:

```text
npm run corpus:freeze
npm run corpus:accept -- --frozen <bundle-path>
npm run audit
npm run quality
npm run package:verify
npm run package:build
```

The checked-in corpus is the accepted S3 F1/F2 impact-bound source. The exact
impact SHA is
`sha256.2e361e746e723b662e5600f99109e0e9d9cb62bd3feff6f0235591fa8414bdc2`,
and F4 depends on `S3-F2-T13`. All twelve S3-F3 tasks remain dormant with zero
variant, fixture, and slot evidence. Freeze and audit reject dormant semantic
commands, catalogs, modules, or synthetic fixtures.

Acceptance runs the four accepted fixtures and seals an offline reconciliation
of `WD40-001` through `WD40-040`. It does not invent per-slot browser outcomes.
Its report status is `accepted_fixture`; `liveCorpusCertified` and
`liveReviewCertified` remain false. The Stage 2 owned Playwright
application/recovery/Review adapter is implemented and locally verified, but
no real Workday proof is claimed by this Stage 3 fixture acceptance.
See `docs/corpus-release.md` and `docs/owner-test-backlog.md`.
