# C3 Applications

C3 has two entry points: paste supported job links into **Applications**, or open a
job and choose **Prepare this job** in the extension. Both use the same queue and
ATS-specific filling engines. Filling stops before submission. **Submit** for Workday is a separate,
per-application action after reviewing the employer's page.

The extension also offers **Fill current page** on HTTPS pages, including
sites outside the supported ATS list. It uses the saved applicant profile to
fill recognized empty text fields, text areas, and exact native dropdown options
on the current page. It reports partial completion and preserves
existing entries. It does not upload files, choose checkbox/radio answers,
operate custom dropdowns, log in, advance pages, or submit. Embedded forms need
browser access permission; inaccessible frames are not covered by this action.
**Undo field fill** and **Redo field fill** retain up to ten fills in each page
until reload. They refuse to overwrite subsequent edits. Reload the unpacked
extension after upgrading to enable its active-tab and scripting permissions.

## Start locally

Use Node 22.18 or later. From this checkout:

```text
npm --prefix executioner ci
npm --prefix executioner run product
```

The service listens only on `http://127.0.0.1:47831`. It prints the location of
the pairing-key file, without printing its contents. In Chrome's extension
manager, enable developer mode and load `executioner/extension` as an unpacked
extension. Open its popup, paste the key from that file, and select **Connect**.
Chrome requests debugger access so C3 can operate the selected application tabs.

Choose **Open workspace** in the extension. Enter your applicant details,
choose a default PDF resume, and save. Existing prepared C3 profiles can also be
imported. Workday account credentials last only for the service session. An
optional Gmail app password enables the existing IMAP verification integration;
Python 3 must be available, or set `HUNT_C3_PYTHON` to its executable path.
Existing signed-in accounts can run without entering credentials again.

Paste one job URL per line, or use the extension on a specific job. Set the
number to fill concurrently, from 1 to 30; the default is 6. Jobs for the same
employer run sequentially because they share account cookies. All jobs use tabs
in the connected browser, rather than launching separate browser profiles.
Once a draft reaches Review, C3 disconnects its automation session and leaves
its tab loaded for inspection. Chrome may independently unload background tabs.
Opening an unloaded tab reloads the employer's saved draft, which may open on
its first page.
**Open** does not refill, advance, or submit it. **Refresh Review** navigates the
saved pages back to Review without filling answers, stopping if required fields
are missing or invalid. The refreshed page stays loaded for inspection. Login or
other unsupported screens need attention. Submit always requires the current
Review contents, a fresh digest, and confirmation.

The concurrency setting is a maximum, not a hardware capacity guarantee. Each
active Workday tab still runs the employer's application and uses browser memory
and CPU. If a large batch causes memory pressure, pause it and lower concurrency
before retrying. The queue can hold more links than it fills at once. Completed
Review tabs also consume browser memory while they remain loaded.
If you close a tab, use **Retry** to reopen and verify the employer's saved draft
before reviewing or submitting it later.

The Applications screen shows progress and lets you pause, retry, remove, restore,
or open the actual application tab. Removing a queued or paused job and changing
concurrency support Undo/Redo. Updating a saved profile and resume also supports
Undo/Redo during the current UI session. Each queued job keeps its own snapshot;
later profile changes do not silently change queued applications.

Missing answers can receive editable suggestions from C3's existing resolver.
Drafts with suggestions, unresolved questions, or retained answers that were not
verified against owner facts show **Owner review needed**. Refresh Review keeps
that notice; Retry reconciles the saved draft again, including prior Review pages.
Inspect **every answer and the attached resume** in the employer's tab. After
editing a completed draft, use **Refresh review**. The Submit confirmation is
bound to that review. A changed review is rejected before clicking Submit.
Submission is never retried automatically. If confirmation is unclear, check the
employer site; C3 records an uncertain outcome rather than clicking again.
Profiles explicitly marked as synthetic/non-submittable cannot use Submit.

## C1 and C2 handoff

Run Hunt's C0 backend on the same computer as the local C3 service. The authenticated
**Applications** navigation opens this same interface. From a job's details choose
**Fill application**, or select up to 30 jobs and choose the corresponding bulk
action. C1 must have verified an external Workday destination and C2 must have a
selected resume marked ready for C3. Each job receives that exact selected PDF.
Easy Apply jobs remain excluded. C3 queue entries retain the C1 job ID.
Already applied, cancelled, and discovery-suppressed jobs are also excluded.
The Applications list shows the selected PDF filename and C2 version, with a
link back to the Hunt job. The job detail page shows C3's current stage. Review
means the draft is ready to inspect, not that an employer received a submission.
Re-handing off a different PDF for an existing application is rejected with an
explanation instead of silently keeping an outdated selection.

The gateway validates the entire selection before sending it. Each PDF is sent
separately to bound transfer size. If the service fails midway, already queued
jobs remain visible; retrying the selection deduplicates them. This product path
does not yet publish application outcomes back into C1's status fields.

## Storage and recovery

The default private data directory is `%LOCALAPPDATA%/Hunt/c3-product` on Windows,
or `~/Hunt/c3-product` elsewhere. Override it with `HUNT_C3_PRODUCT_ROOT`. The
gateway can locate an alternative key with `HUNT_C3_TOKEN_FILE`. Applicant data,
PDFs, queue state, the pairing key and consumed verification-message identifiers
remain outside Git. Passwords are not persisted. Protect this directory as
applicant data.
Removed entries retain their saved inputs so they can be restored; removal is
not permanent deletion of applicant data.

Each fill attempt also preserves discovered question types, control types, options,
and constraints in private learning journals. These are observations, not verified
answers: they do not automatically replace applicant facts. Basic profile edits
preserve previously discovered fields. If a discovery journal cannot be saved,
C3 pauses with the draft preserved.

If progress cannot be saved, C3 halts new work and pauses active jobs. Fix the
storage problem, then choose **Retry saving progress** or retry a paused job.
A background save does not silently resume work. Submission intent must be saved
successfully before C3 can click the employer's Submit button.

For a confirmed Workday site error, C3 makes bounded reload attempts, then reopens
that same posting once while retaining the saved draft. Persistent site errors
still pause. Rejected sign-in for an existing account can use the configured
email connection for one password-reset attempt.

C3 recognizes Workday's Take Assessment step and tries its normal Save and
Continue action. If Workday requires the assessment, C3 preserves the draft and
reports that requirement. It does not count an assessment handoff as reaching
Review or complete an external assessment automatically.

A service restart pauses outstanding work. Reconnect the extension and retry the
saved drafts. A job interrupted during submission becomes **submission uncertain**
and cannot be automatically retried. User-closed tabs, CAPTCHA, MFA, account
rejections and unsupported pages can still need attention. Workday and the hosted ATS families listed below are supported; arbitrary
employer URLs are rejected by the queue.

## Verification boundary

The product browser check uses the actual unpacked extension, HTTP queue, shared
browser, existing profile/resume/question handlers, Review verification, and
separate submission against controlled synthetic pages. It also checks changed
reviews and duplicate submission requests. It does not certify 30 simultaneous
live employer sites, real Gmail delivery, or every Workday account variant.

```text
cd executioner
node --test tests/product/queue.test.ts tests/product/product-browser.test.ts
```

Set `C3_BATCH_CHECK_COUNT=30` for the larger concurrent check, and optionally
`HUNT_C3_CHROMIUM` to a compatible installed Chromium executable. No live employer
receives these test submissions.


## Hosted ATS support

The multi-ATS candidate adds Greenhouse, Lever, Ashby, and Workable hosted job
forms to the batch queue, current-tab extension, and selected-resume handoff.
Supported hosts are job-boards.greenhouse.io, boards.greenhouse.io,
job-boards.eu.greenhouse.io, jobs.lever.co, jobs.eu.lever.co, jobs.ashbyhq.com,
and apply.workable.com. Use a specific job link. Custom domains and embedded
forms are not covered. The legacy Greenhouse host redirects to its canonical
host without changing job identity.

Submission is disabled for these four families. Review means verified filled
fields and an available final submit control, not a submitted application.
Existing Workday behavior is retained.

The adapter reads question owners, actual choices, and UI behavior before using
the shared answer resolver. It supports text, paragraphs, native selects,
comboboxes with single selections or chips, location suggestions, native and
ARIA-backed radios, individual checkboxes, grouped checkboxes, yes/no buttons,
and resume uploads. Required checkbox groups are answered as groups, not by
selecting every option. Ashby's answer-one-of-several sections remain supported.
Unrecognized required controls, additional attachments, and oversized required
questions pause for review. Synthetic defaults remain non-submittable.

### Expanded compatibility evidence

Forty new jobs across eighteen employer tenants were exercised with entirely
fictional applicant details and PDF resumes. No applications were submitted.

| ATS | Jobs | Latest verified result |
| --- | ---: | --- |
| Greenhouse | 12 | 12 reached pre-submit after repairs |
| Lever | 10 | 10 reached pre-submit after the checkbox-group correction |
| Ashby | 12 | 5 passed the final concurrent run; 6 passed a serial retry; 1 coding assessment excluded |
| Workable | 6 | 6 reached pre-submit, including different jobs after repairs |

Employers: Cloudflare, Figma, Discord, Twilio, Reddit; Palantir, Spotify,
HighLevel, Zoox; Notion, Ramp, Vanta, OpenAI, Perplexity; Starling, First Focus,
AION, and Galois. Six holdout jobs were selected after the initial fixes.

The corrected evidence captures 183 distinct ATS/question/control combinations.
This is structural coverage, not proof that every question has a correct
real-applicant answer. Custom questions can still use synthetic defaults in test
mode. Name/contact facts and catalog mappings are distinct from those defaults.
The learning record includes observed choices, catalog classification, answer
kind, and provenance where recorded. Earlier runs retained less metadata.

Ashby's intermittent application-unavailable and location-lookup failures cleared
on a serial retry without another code change. Their cause is not conclusively
established; concurrent reliability is not accepted on this evidence. The sample
is not a platform-wide success-rate estimate. External assessments stay excluded.

The four-ATS mixed extension queue and C1/C2 selected-resume handoff have fixture
coverage. They do not establish a live full C1-to-C2-to-C3 recruiting workflow.
Focused verification: four hosted-form checks, twenty-two existing product,
extension and Workday checks, eight gateway checks, and TypeScript validation.

## Common ATS inventory

C1 already recognizes Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Workable,
Jobvite, iCIMS, BambooHR, Taleo, Oracle, ADP, UKG, Breezy, JazzHR, Recruitee, and
Pinpoint. Recognition or job discovery does not imply C3 can fill that platform.
SAP SuccessFactors and Teamtailor are also relevant expansion targets. This is
a practical common-platform inventory, not an exhaustive list of every ATS.

Next compatibility groups are iCIMS, Oracle Recruiting/Taleo, SAP SuccessFactors,
and SmartRecruiters, followed by the other inventory entries. Each needs
public job examples, UI inspection, and independent end-to-end evidence before
being enabled in C3. Do not route unknown hosts to a generic form filler.

Provider references: [Lever application forms](https://help.lever.co/s/article/Configuring-your-Lever-Application-Form),
[Ashby postings](https://docs.ashbyhq.com/job-postings),
[Greenhouse job boards](https://support.greenhouse.io/hc/en-us/articles/360062032092-Create-a-new-job-board),
[iCIMS candidate guide](https://community.icims.com/articles/Knowledge/Candidate-Guide-to-the-iCIMS-Talent-Platform),
[Teamtailor ATS](https://www.teamtailor.com/en/applicant-tracking-system/).


Additional live inspection found two Bosch SmartRecruiters postings, but its
application entry remained blank; the iCIMS candidate endpoint returned 403;
and a SAP job entry showed security verification. None are enabled as C3 fill
support, and no access challenge was bypassed. Evidence distinguishes public
job discovery, application-page inspection, and a completed C3 fill.


## Answer audit and generic partial filling

The October 15, 2026 check used 12 additional employers from the owner's tracker
with fictional applicant data. Eight jobs reached pre-submit; one posting
redirected to an error page, two stopped at dropdowns, and one stopped on a long
privacy question. Completion is not an answer-accuracy score. After repairs,
38 populated name/email/phone values matched the test profile. Saved narrative
and current-employment answers were also checked on controlled forms, including
changed values on fresh applications. Full-name variants now share profile
mapping; URL questions produce URL-shaped defaults. Defaults remain suggestions.

Existing valid site values are preserved, which can retain an employer's
prefilled location instead of the saved profile location. Discovered custom
questions currently store unanswered metadata, not editable arbitrary saved
answers. Neither behavior should be described as verified profile matching.

`fillGenericIdentityFields` is an internal partial-fill prototype, not connected
to the Applications queue or extension action. It fills recognized empty identity
inputs from an admitted profile and verifies readback. It does not navigate,
upload, answer custom questions, accept consent, or submit. A live fictional-data
check filled four identity fields on Peripheral's Dover form. This does not
establish support for the entire Dover application flow or other unknown sites.
