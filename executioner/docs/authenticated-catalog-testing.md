# Authenticated catalog testing

This harness tests the full C3 v3 account-access flow against Workday postings
without changing the source catalog. It identifies an account realm by the
lowercase Workday hostname plus the first non-locale path segment. A prior URL
under the same realm counts as previously tested even when the posting differs.

The current catalog contains 100 unique companies and one current posting per
company. After the first full authenticated pass, rows 43, 76, and 82 were
replaced with different companies because the predecessor realms were blocked
by external account or provider state. The predecessor attempts remain in
immutable external evidence for later special-case investigation.

Every replacement must verify HTTP 200, exact Workday target identity, and the
visible job title before its candidate row can replace the source catalog.
Those public checks do not prove that the application entry point works, so
catalog rows remain `unverified_candidate`. Authenticated outcomes stay in
their immutable external cohorts rather than rewriting the public catalog.

## Refresh the public catalog

Run the refresh from `executioner` with Node 22.18 or newer. By default it
refreshes the current Workday, Greenhouse, Lever, and Ashby catalogs. It keeps
each company and board at its existing row count, preserves postings still in
the official hosted feed, and replaces stale hosted postings from the same
company board. Workday retains its existing one-company-per-row refresh model.
Use a fresh protected output root outside the repository:

```powershell
node scripts/refresh-public-catalog.ts `
  --output-root C:\absolute\protected\public-catalog-refresh `
  --concurrency 3 `
  --verify
```

Pass `--csv` once or repeatedly to refresh selected files instead:

```powershell
node scripts/refresh-public-catalog.ts `
  --csv ..\greenhouse_test_jobs.csv `
  --csv ..\lever_test_jobs.csv `
  --output-root C:\absolute\protected\public-catalog-refresh `
  --verify
```

The command never overwrites a source CSV. Each catalog publishes a unique,
immutable run directory containing `candidates.csv`, `verification.jsonl`, and
a manifest that binds both files and the source catalog by SHA-256. Promote a
candidate only after all 100 verifier records match and the manifest digests
recompute exactly. Keep candidates at `unverified_candidate`; record
authenticated application-entry outcomes only in the external cohort.

`wd_test_jobs_stale.csv` is intentionally excluded because it tests closed-job
behavior. `other_ats_test_jobs.csv` is historical migration evidence and lacks
the canonical URLs and board identities needed for safe automated refresh.

## One-time setup

### Local requirements

- Windows under the same user that will run C3. DPAPI records and the Gmail
  refresh grant in Windows Credential Manager are bound to that Windows user.
- Node.js 22.18 or newer within the Node 22 major line, with the Executioner
  dependencies installed. The isolated Windows browser runner rejects other
  major versions because those runtime combinations are not certified.
- A rightmost secondary monitor for headed live runs. The Stage 2 runner fails
  closed when its independent monitor and desktop checks cannot be satisfied.
- A protected storage root outside every repository for live run state and a
  separate protected root for catalog results. Keep the storage path short
  enough that the derived browser profile plus `SingletonLock` remains below
  the Windows 260-character path boundary; preflight rejects longer paths.
- One Gmail-enabled Google account. Its normalized profile email must exactly
  match `HUNT_C3_TEST_ACCOUNT_EMAIL`, because C3 binds Gmail authorization to
  the email sealed into the Workday account bundle. A Gmail password or app
  password is neither needed nor accepted.
- One Workday signup password in a protected, ignored source file. The current
  migration path reads exactly one `HUNT_C3_TEST_ACCOUNT_EMAIL` and exactly one
  `HUNT_C3_TEST_ACCOUNT_PASSWORD` after the file's SHA-256 digest is pinned.

### Google Cloud and OAuth

1. Create or select a Google Cloud project and enable the Gmail API.
2. Configure Google Auth Platform branding, audience, and data access. For an
   External app in Testing, add the test Gmail account as a test user.
3. Create an OAuth client with application type **Desktop app** and download its
   installed-client JSON.
4. Move the JSON out of Downloads and every repository. The standard Windows
   location is
   `%LOCALAPPDATA%\Hunt\oauth\google-installed-client.json`.
5. Disable ACL inheritance on the directory and file, then grant Full Control
   only to the current Windows user and SYSTEM. Keep the JSON as a regular file,
   never a link. Do not put its client secret in `.env`, arguments, logs, or
   Terraform state.
6. Configure only `https://www.googleapis.com/auth/gmail.readonly`.

Google's [Gmail Node quickstart](https://developers.google.com/workspace/gmail/api/quickstart/nodejs)
documents the Gmail API, consent screen, Desktop client, and local browser
requirements. If an External app remains in Testing, Google says refresh
tokens for scopes beyond basic identity can expire after seven days; see
[Manage App Audience](https://support.google.com/cloud/answer/15549945).

The first C3 Gmail bootstrap never opens or controls a browser. While the
provisioning command waits, it creates the protected one-time file
`%LOCALAPPDATA%\Hunt\oauth\gmail-oauth-authorization.url`. The operator opens
that file in a browser of their choice, selects the matching Gmail account,
completes any Google password or MFA challenge, and grants consent. Keep the
provisioning command running until the loopback callback completes. Open the
handoff promptly because it expires after 210 seconds. C3 verifies the parent
directory ACL, creates the file with an exact current-user-and-SYSTEM ACL,
deletes it after the callback, timeout, cancellation reconciliation, or other
ordinary failure, verifies the Gmail profile and requested scope, and retains
an opaque, scope-bound refresh grant. Do not copy, share, or log the handoff's
contents. If a machine or process crash leaves it behind, the next attempt
returns `gmail_oauth_handoff_unavailable`; first confirm no Gmail bootstrap is
running, delete only that exact file, and retry. Later jobs can reuse the grant
silently until Google expires or revokes it.

### Current configuration contract

The local `.env` may point `HUNT_C3_GMAIL_CREDENTIALS_PATH` at the protected
installed-client JSON, but C3 v3 does not treat legacy Gmail environment
variables as authorization. The OAuth profile itself must match the Workday
email sealed from `HUNT_C3_TEST_ACCOUNT_EMAIL`. Never load secret-looking
`HUNT_*` values into the process environment when invoking C3 provisioning
commands; pass the protected source file only to the pinned migration command.

For each verification request, Gmail searches only for the current job's company
within the preceding hour. The lower bound is fixed when the journey starts and
the upper bound advances with each poll. No sender allowlist is required. A
message is usable only when exactly one candidate remains and its exact recipient,
Workday tenant, target, and HTTPS verification link all validate. Multiple or
mismatched candidates fail closed.

### Per-job account and Gmail provisioning

Prepare each job just in time because its approval and secret handles expire in
30 minutes:

```powershell
npm run prepare:s2-run -- `
  --storage-root C:\absolute\protected\hunt-c3-storage `
  --target-url https://tenant.wd5.myworkdayjobs.com/Careers/job/Title_R12345 `
  --account-mode fresh_create `
  --application-profile C:\absolute\protected\hunt-c3-inputs\application-profile.json `
  --application-resume C:\absolute\protected\hunt-c3-inputs\application-resume.pdf
```

For a full application and Review journey, both application-source arguments
must be present together. Keep those files outside the repository and supply
only their protected absolute paths; never put applicant values on the command
line or in operator output.

Pin the complete credential source before migrating it into the prepared
journey. Do not print or copy either credential value:

```powershell
$accountSource = 'C:\absolute\protected\hunt-account.env'
$accountSha256 = (Get-FileHash -LiteralPath $accountSource -Algorithm SHA256).Hash.ToLowerInvariant()
npm run migrate:s2-env-account -- `
  --config C:\absolute\protected\hunt-c3-storage\transient\<run>\owner-input.json `
  --env-source $accountSource `
  --sha256 $accountSha256
```

Create protected, external company-policy and Gmail-bootstrap JSON files using
the exact schemas in the Gmail authorization section of `executioner/README.md`.
Put the current job's company, target host, and tenant in the company policy.
Bind the bootstrap to the newly prepared owner file, that policy file, the
preallocated Gmail handle, the Desktop client ID, and the protected installed
client path. Then provision Gmail:

```powershell
npm run provision:s2-gmail -- `
  --config C:\absolute\protected\hunt-c3-storage\transient\<run>\owner-input.json `
  --gmail-bootstrap C:\absolute\protected\hunt-c3-inputs\<run>-gmail-bootstrap.json
```

If this is the first bootstrap for the Gmail account and Desktop client, leave
the command running and open
`%LOCALAPPDATA%\Hunt\oauth\gmail-oauth-authorization.url` yourself. C3 does not
launch or take focus from your browser.

For this catalog test, run only through the account-verified slice. It creates
or signs into the Workday account, follows an email link when required, performs
the post-verification sign-in when Workday requires it, and stops after the
application page is independently classified:

```powershell
npm run live:s2:slice -- `
  --config C:\absolute\protected\hunt-c3-storage\transient\<run>\owner-input.json `
  --stop-after account_verified `
  --evidence-root C:\absolute\protected\hunt-c3-storage\retained\<run>\evidence
```

The current live runner supports verification links. If Workday sends only a
numeric code, record `email_code` and `unsupported_code`; do not improvise a
code-entry path. Never continue to final job-application Submit.

### Server deployment

The current implementation is a local Windows design. Its DPAPI ciphertext,
Credential Manager refresh grant, desktop OAuth callback, monitor attestation,
and browser profile do not transfer to another machine or service identity.
Deployment therefore needs either:

- a Windows runner provisioned interactively under its final service user; or
- a new server secret-store and OAuth adapter backed by the deployment
  platform's secret manager, with equivalent identity, scope, expiry, replay,
  and audit checks.

Terraform can enable the Gmail API with
[`google_project_service`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/google_project_service),
plus provision ordinary server infrastructure and secret stores. The provider's
[`google_iam_oauth_client`](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/iam_oauth_client)
is for Workforce Identity Federation and is not the Google Auth Platform
Desktop Gmail client used here. Keep Desktop-client creation, downloaded-secret
admission, and human Google consent outside Terraform.

## Automation boundary

The catalog harness already automates fresh-realm selection, immutable run and
shard creation, exclusive result recording, and complete-run compilation. A
single operator command can safely automate the remaining mechanical steps per
job: prepare the journey, pin and migrate the Workday credentials, generate the
protected target-bound company-policy and bootstrap files, reuse the Gmail
refresh grant, launch the bounded live slice, and record its result.

That command must still stop for the first Google sign-in/MFA/consent and any
Workday CAPTCHA/MFA/access-control challenge. These are explicit blocked or
manual outcomes, not reasons to broaden mailbox or browser permissions.

## Prepare

Use absolute canonical paths. The output root must already exist and must live
outside the repository. The command creates one immutable run directory with
`manifest.json`, `jobs.csv`, five shard CSVs, and an empty `results` directory.
URLs are normalized by removing the reviewed `source=LinkedIn` query parameter.

The retained refreshed-catalog cohort selected rows 1–10 by supplying an
explicit history CSV containing the header and rows 11–100. It contains ten
jobs in one logical shard. For later cohorts, build the history CSV from every
row already tested; actual parallelism must stay within the active agent and
machine headroom limits.

```powershell
node scripts/prepare-authenticated-catalog.ts `
  --catalog C:\absolute\path\to\hunt\wd_test_jobs.csv `
  --history-csv C:\absolute\protected\tested-history.csv `
  --output-root C:\absolute\protected\catalog-runs `
  --shards 1
```

For each future cohort, update `--history-csv` to contain every catalog row
whose authenticated result has already been recorded.

## Execute and observe

Each worker receives one shard CSV and processes its rows in order through the
existing C3 v3 live runner. Existing protected account and Gmail OAuth handles
remain the only credential inputs; neither credentials nor OAuth tokens belong
in a shard, result, command line, log, or finding.

For every job, the worker must independently inspect the browser after C3's
classification. Stop when the application page is ready and never click the
final job-application Submit button. Record even minor behavior differences,
including page/account/mailbox misclassification, incorrect typing or clicks,
missed clicks, late or missed verification, wrong verification parameters,
unexpected waits, and navigation misclassification.

`verification_required` starts as `unknown`. Search only for the current job's
company within the fixed preceding-hour window. Record `email_link` when Gmail
returns one uniquely validated confirmation link. Record `email_code` and
`unsupported_code` when the message supplies only a numeric code that the
current runner cannot consume. Jobs that already expose an account for the
current email must be recorded as `existing_sign_in`, not silently treated as a
fresh-account test.

Do not change C3 behavior, selectors, classifiers, or the catalog during this
run. Complete every job first, then compile and group the findings.

## Record

Write one JSON file per job with exactly this shape, using the `run_id` and
`job_id` from the manifest/shard. Evidence fields contain SHA-256 digests only.
Finding summaries are one line, at most 240 characters, and must not contain
URLs, email addresses, credentials, tokens, or secret values.

```json
{
  "schemaVersion": 1,
  "runId": "authrun_00000000000000000000000000000000",
  "jobId": "job_000000000000000000000000",
  "startedAt": "2026-08-05T18:01:00.000Z",
  "finishedAt": "2026-08-05T18:02:00.000Z",
  "outcome": "application_reached",
  "observedAccountFlow": "fresh_create",
  "verificationRequired": "yes",
  "verificationMethod": "email_link",
  "verificationResult": "verified",
  "postVerificationSignIn": "required_succeeded",
  "applicationPageReached": true,
  "c3PageClassification": "application_ready",
  "independentBrowserClassification": "application_ready",
  "classificationAgreement": "match",
  "timingsMs": {
    "accountEntry": 0,
    "mailboxWait": 0,
    "verificationNavigation": 0,
    "postVerificationSignIn": 0,
    "total": 0
  },
  "findings": [],
  "evidence": {
    "acceptanceSha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "monitorAckSha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "screenshotSha256": "0000000000000000000000000000000000000000000000000000000000000000"
  }
}
```

Record through a file so secrets cannot be placed inline on the command line:

```powershell
node scripts/record-authenticated-catalog-result.ts `
  --run-root C:\absolute\protected\catalog-runs\authrun_... `
  --result C:\absolute\protected\worker-output\result.json
```

Recording is exclusive: a second result for the same job is rejected rather
than overwriting the first worker's observation.

## Compile after every job reports

```powershell
node scripts/compile-authenticated-catalog-results.ts `
  --run-root C:\absolute\protected\catalog-runs\authrun_...
```

Compilation fails closed if any expected job is missing, any unknown result is
present, or a job is duplicated. A complete run produces `results.csv` and
`summary.json` once; neither can be overwritten by a later invocation.
