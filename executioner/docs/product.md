# C3 Applications

**C3.1** prepares queued applications on Workday, Greenhouse, Workable, Lever and Ashby. **C3.2** is the extension's current-page fill.

Application filling skips optional fields by default in C3.1 and C3.2, even when
saved profile answers are available. Existing optional values are preserved. Fields that
become required are reconsidered from the current page. Optional attachments are
not uploaded automatically. When an employer asks for a transcript, cover letter, or other supporting document, supply that file yourself. C3 uses the selected résumé only in a field identified as a résumé or CV.

To set or revoke AI screening consent, open **Profile**, go to **Disclosures**, and find
**Allow AI screening of my application when an employer requires an answer**. Choose
**Yes** to consent, **No** to decline, or **Not answered** to decide on each employer
page, then choose **Save profile**. The next fill or retry uses your current preference,
including for saved drafts. C3 preserves existing employer-page decisions and skips
optional prompts. For an employer that only offers a required agreement checkbox,
choosing **No** leaves the checkbox empty for you to review. Changing a saved decision
pauses active queue runs so you can retry them with the new choice. If a previous fill
included AI consent and you undo that fill, use **Fill current page** to apply the new preference.

## Diagnosing a paused draft

A paused job can show the component and operation that observed the failure. For example, an upload failure during preview verification means C3 could not confirm the attachment. An employer error reported by the workflow means C3 recognized the page and stopped. Compare the recorded operation with the employer page before changing the reader, matcher, or browser action.

The service decides which answer to use. Browser readers describe the question, options and current selection. Browser interactions apply the answer and read the resulting control state. The full workflow also handles accounts, navigation and final Review. The current-page action stays on the selected document.

Both workflows use the same rules for question wording, saved answers and consent. Site adapters handle the browser details that differ, including the Workday account page, BambooHR province menus and the Jobvite résumé dialog. The extension ships those adapters with its shared field reader and filler. Keep the complete `extension` folder, including its subfolders, together when updating an unpacked installation.

## Question matching and review backlog

Both workflows use the service’s shared resolver for approved question wording, employer-name patterns and question keywords
to stable categories linked to profile facts. Employer names remain context: a
question about another company does not inherit the target employer's answer.
Current employment and prior employment share a family but retain their time scope.
Saved profile labels are not dictionary keys, and matching never rewrites saved facts.

Answer equivalents are scoped to the relevant fact, such as Male/Man for gender and
BSc/Bachelor of Science for degree. A subject such as Computer Science is separate
from a degree level. Selection and field verification share the existing semantic
alias rules. Typing a dropdown search is not proof of a committed selection.

Unrecognized wording receives ranked suggestions from local token and character
similarity. Scores are not probabilities; suggestions do not authorize use of a
personal fact or automatically change the dictionary. When existing draft policy
allows it, C3 continues with a site-valid editable fallback and marks review needed.
This requires no model download or external AI request.

Private `learning/<job>/<run>/.../matching-backlog.json` files retain observed question
text, available options, control type, constraints when observed, company identifier,
posting URL, suggested matches, relevant requested answer, chosen answer and fill
outcome. Attempts and confirmed product readbacks are distinct. Sensitive URL
parameters and account password fields are excluded. These are product observations,
not independent live-test certifications. Existing logs are retained without being
automatically promoted into approved mappings.

The authenticated read-only `GET /matching/backlog?offset=0&limit=50` endpoint and
`hunt_matching_backlog` MCP tool return paginated run journals. `GET /matching/dictionary`
returns the approved question-to-fact mappings and answer groups. Review the backlog
after a batch, then approve changes separately. C3.2 observes the selected document,
asks the service to resolve those exact controls, commits supported answers, and
reads their resulting state. Newly revealed fields receive another bounded pass.
**Undo fill** reverses supported edits made by **Fill current page** across its fill
passes. It preserves later edits. **Prepare this job** uses a separate workflow.
To revise a screening answer filled during queued preparation, change it on the
employer page. For a SmartRecruiters list choice, use the employer's **Clear value**
control when it is available. A Yes/No question with no clear action stays answered
until you choose a different answer.
The popup reports when suggested answers or uncertain matches need review.

Update the local service and reload the existing extension together. The service
checks the extension's shared-matching capability before filling. The extension
loads from its own folder; it does not import TypeScript or a second dictionary.
C3.2 does not advance pages. Custom controls without a supported reversible action
remain unchanged and enter the private backlog for review.

C3 has two entry points: paste supported job links into **Applications**, or open a
job and choose **Prepare this job** in the extension. Both use the same queue and
ATS-specific filling engines. Filling stops before submission. **Submit** for Workday is a separate,
per-application action after reviewing the employer's page.

The extension also offers **Fill current page** on HTTPS pages, including
sites outside the supported ATS list. It uses the saved applicant profile to
fill recognized empty fields and supported saved-answer choices on the current
page. It can attach the saved resume to an unambiguous resume input in the main
document. It reports partial completion, preserves existing entries and flags
conflicts with saved answers. Some custom controls and attachments still require
review. It does not log in, advance pages, or submit. Embedded forms need
browser access permission; inaccessible frames are not covered by this action.
On a supported Workday account page, the same button uses the protected account
filler for the saved email, password, confirmation password and approved account
terms. It verifies the fields without clicking Sign In or Create Account.
Account passwords are not retained in Undo/Redo history. A different email or
changed document blocks account filling; unrelated checkboxes are not selected.
An employer may save an uploaded resume separately from the form fields. Undo
cannot remove that remote attachment. C3 retains the upload attempt to avoid
uploading it again and asks you to review the attachment on the employer page.
**Undo fill** and **Redo fill** appear when page history is available and retain up to ten fills in each page
until reload. They refuse to overwrite subsequent edits. Reload the unpacked
extension after upgrading to enable its active-tab and scripting permissions.

Field actions are bound to the page documents selected when the action starts.
Navigation or reload during a request cannot redirect a fill into the new page.
If a frame changes, completed changes remain undoable and the popup reports
partial completion. Requests have a deadline; an unconfirmed queue request tells
you to check Applications before retrying. A rejected replacement pairing key
leaves the previously saved key intact.

## Start locally

Use Node 22.18 or later. From this checkout:

```text
npm --prefix executioner ci
npm --prefix executioner run product -- --open
```

The service listens only on `http://127.0.0.1:47831`. The `--open` option opens
an authenticated workspace in your default browser without printing its key.
In Chrome or Brave's extension manager, enable developer mode and load
`executioner/extension` as an unpacked extension. Keep the workspace open in that
same browser, open the Hunt C3 popup, and select **Connect to local app**. C3
validates the workspace's key, remembers it, and reconnects when the service
restarts. The workspace tab can then be closed. Chrome or Brave requests debugger
access so C3 can operate the selected application tabs.

If your default browser differs, open the workspace in the browser where Hunt is
installed and pair it using the key file printed by the launcher. The popup's
**Connection settings & help** contains a manual **Pairing key** fallback and
the extension version. Once connected, **Connect to local app** moves into
that panel. A rejected key
does not replace your saved connection. If old workspace tabs contain different
keys, close those tabs and retry. Omit `--open` when starting without a browser.

Choose **Open workspace** in the extension. Enter your applicant details,
choose a default PDF resume, and save. Existing prepared C3 profiles can also be
imported. On Windows, **Save account** encrypts the application password and optional
Gmail app password with Windows current-user protection in `account.dpapi` under
the local product storage folder. The service restores them on restart; the
profile export and browser never receive the saved passwords. Other platforms
keep credentials only until restart. Replacing credentials is not part of profile
Undo/Redo. Stop C3 and remove `account.dpapi` to forget the saved account.
A Gmail app password must pass a login and read-only inbox check before it is saved;
Python 3 must be available, or set `HUNT_C3_PYTHON` to its executable path.
Existing signed-in accounts can run without entering credentials again.

Settings distinguishes saved credentials from a successful connection check.
Leave password inputs blank to retain saved values for the same email. A failed
replacement does not erase the saved account. **Recheck saved Gmail** uses the
saved credential and retains the last successful check alongside any later
failure. A Gmail outage does not prevent restoring the application password.
Employer sign-in is checked separately for each employer.

Prior-employment and employee-referral questions default to **No**, as configured
by the owner. This employment default includes current/former, contract and internship
wording for the selected employer. It is separate from saved facts and does not
redefine the meaning of current or past employment. Employer account terms and recruitment privacy consent default to
agreement. An explicit saved answer takes precedence. Final accuracy declarations,
signatures and application submission still require owner review.

Workday's protected account route and application engine share the `workday-page-v1`
observation rules. Current visible structure and messages distinguish account forms,
explicit verification or rejection, application steps, Review, completed/closed
pages, employer errors and security challenges. Loading and unknown observations
are retained; neither is a credential rejection. Error and security evidence takes
precedence over an application section visible behind it. A loading transition can
retain the source form's identity without granting permission for another action.

The protected account route may refresh a confirmed, selected-document employer
error once. It then inspects the new document without resetting its registration
or sign-in attempt guards. Recovery does not authorize password resets, security
challenges or submission. Current-page filling only reports these states and never
refreshes or advances. An old extension without `workday-page-v1` must be reloaded
before the updated service will perform Workday account actions.

Account journals and private application learning artifacts retain observation
version, document identity, fixed signal codes and conflicts, without field values.
Hosted ATS routes separately require visible application-form evidence and reject
account/code controls or an observed security challenge; their URL is not proof of
form readiness. These hosted checks do not claim Workday's state coverage for other
employers. Review must be structurally valid and stable. Answer mismatches or unavailable
current-run comparisons remain explicit owner-review warnings. Attachment verification
retains its separate selected-file and completion checks.

Workday tries Create Account when employer-account history is unknown, using the
saved credentials and checking the confirmation password before its single click.
An explicit account-exists response switches to Sign In, including a verified
notice already visible on the selected posting when a run resumes. Confirmed account access
is remembered per employer and email; uncertain registration prevents duplicate
creation on retry. For an observed verification request after registration, C3
uses the saved mailbox connection when available. If the employer requests
sign-in again after C3 has already tried it and opened the verification link,
C3 pauses for the owner to check the account.
CAPTCHA, password resets and unconfirmed outcomes remain visible stops.

Draft filling uses saved details first, then reviewable defaults for unsupported
routine answers. Phone type defaults to Mobile; Canada phone-code choices prefer
Canada (+1). Other unmapped choices use the first available option. Generated
answers stay separate from saved facts and require review; they are draft
placeholders, not verified claims about the applicant.

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

For hosted forms, C3 remembers a required resume after observing the upload
field and its required marker, including after failed attempts and service restarts. Greenhouse
can remove that field after uploading. C3 then checks a matching upload response
and a receipt bound to that browser document. Removing or replacing the file,
reloading the page, or losing that receipt requires fresh verification. Detaching
and reconnecting to the same loaded document preserves the receipt. Forms without
a resume field remain supported; C3 cannot reconstruct evidence from an older
draft whose field disappeared before it was observed.

Workable resume confirmation reads the PDF from the upload control's own preview
and compares its bytes with the selected PDF. A matching existing preview can be
verified without uploading again. If Workable is still processing a selected file,
C3 waits for its preview. The failure details distinguish a pending upload, an
unavailable preview and a file that differs from the selected PDF.

On Jobvite, SmartRecruiters and other unfamiliar sites, open the employer form and
choose **Fill current page**. Review the fields, choose **Next** yourself, then
repeat on the new page. If an older queued entry owns that application, finish
the saved draft manually with its selected résumé. The extension protects the
draft from having its selected PDF replaced by the default.

If a later employer page opens in another tab and C3 cannot identify the saved
job, reopen the job from **Applications**. If the extension reports that an
existing attachment differs from this job's selected résumé, compare the two
files on the employer page. Replace the attachment there if needed, then use
**Inspect** to check what the employer shows.

If C3 reports a different résumé filename or PDF, open the saved Workday
employer draft and compare its attachment with the PDF selected for this job.
If you decide to replace it, use the employer's attachment control. Choose
**Retry** after correcting a paused draft, or **Refresh Review** for a draft
already at Review. If the employer only displays a filename, its copy remains
unverified. A failed download or a different SHA-256 requires your attention
before submitting.

Workday summary Review checks repeated education and employment answers within
their own rows. Finding the right words elsewhere on the page is not sufficient.
Unavailable row structure stays unverified, and provisional answers retain their
owner-review warning even when the page correctly displays the chosen value.

The owner's terms/privacy preference applies to employer registration and
recognized recruitment consents. Existing selections are preserved. Other
legal acknowledgements and declarations are not treated as approved facts. When
the draft policy permits an editable fallback, required unresolved answers are
marked provisional and recorded for owner review. Unsupported controls still pause.

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
that notice. Retry continues from the current recognized application page without
forcing Back navigation. Earlier pages not revisited during that run remain marked
for owner review. Private review-verification.json records these limits and mismatches.
Inspect **every answer and the attached resume** in the employer's tab. After
editing a completed draft, use **Refresh review**. The Submit confirmation is
bound to that review. A changed review is rejected before clicking Submit.
Submission is never retried automatically. If confirmation is unclear, check the
employer site; C3 records an uncertain outcome rather than clicking again.
Profiles explicitly marked as synthetic/non-submittable cannot use Submit.

## Agent controls

The local MCP server uses the same paired browser, saved profile and partial
filler as the extension. Start the C3 service first, then configure your MCP
client to run Node 22.18 or later with `executioner/src/product/mcp.ts` as its
absolute script path. Set `HUNT_C3_PRODUCT_ROOT` to the same private data folder
used by the service. The MCP process reads the existing key file; do not paste
the key into client configuration or chat. `HUNT_C3_TOKEN_FILE` can select an
existing key file, and `HUNT_C3_SERVICE_ORIGIN` can select another loopback port.

For example, register it with Codex from the repository root:

```powershell
codex mcp add hunt_c3 --env "HUNT_C3_PRODUCT_ROOT=C:\path\to\existing-c3-data" -- node "$PWD\executioner\src\product\mcp.ts"
```

`hunt_status` reports connection, extension version, profile availability and
credential status without exposing answers or secrets. `hunt_account_check`
rechecks the saved Gmail connection and records its result. A successful Gmail
check does not establish that an employer accepts the application password.
`hunt_tabs` lists HTTPS tabs without opening or focusing them.

Use `hunt_page` with `inspect`, an explicit tab ID and its current URL. Use the
returned document ID for `fill`, `undo` or `redo`. Navigation or reload rejects
an old document ID. Popup and MCP actions share the same per-page undo history.
`fill` can upload the saved default resume. Queued jobs must continue through
Applications so their selected resume is preserved. These actions do not log in,
advance pages or submit applications.
Inspect every answer on the employer page; filled-field counts are not proof of
a complete or correct application.

Update the service and reload the existing unpacked extension to enable these
controls. Keep its folder and the service's data folder unchanged to retain
pairing, profile, resume and encrypted credentials. Reloading an employer page
clears its field undo history. An older service reports that agent controls require an
update. A client may need to reconnect before newly registered MCP tools appear.

## C1 and C2 handoff

Hunt's C0 backend connects to C3 at `127.0.0.1:47831` in the backend's own network
environment, using its local pairing-key file. The embedded **Applications**
workspace and C1/C2 handoff require that backend and C3 service to run together.
For a containerized backend, this address is inside the backend container, not
the computer viewing Hunt in a browser.

If Hunt is on a remote server and C3 runs on your Windows computer, starting C3
locally does not connect the server's Applications page. Open the **Hunt C3**
extension on your computer, connect it to your local service, then choose
**Open workspace**. The extension opens the local workspace with its saved
pairing key; a bare localhost link does not supply that key.

### Send directly from the Hunt website

The paired extension accepts handoffs only from `https://agent-hunt-review.mshi.ca`.
The website build must pin the existing extension's public ID with
`VITE_C3_EXTENSION_ID`. Obtain that ID from the authenticated local
`/agent/status` response (`extension.extensionId`) after updating the existing
extension. Do not change its installation directory or manifest key to obtain a
different ID. Set the public ID in the Compose environment before building the
review and frontend images. Both images serve a copy of the website. The
pairing key stays in extension storage.

In the extension's connection settings, **Connect Hunt website** opens the
trusted website with its public extension ID. Hunt checks it against its build
configuration; a URL cannot select a different extension to receive resumes.
Choose **Send to local C3** on a prepared job or in bulk actions. The existing
authenticated export supplies the exact selected PDFs. The extension validates
the bundle and calls `/handoff/import-paused`. In the extension, choose **Open
workspace** to see the imported jobs and selected PDFs. Each job arrives paused.

The website can request only minimal connection status, bundle preview and
paused import. It cannot read saved answers or credentials, obtain the pairing
key, proxy arbitrary local requests or operate employer tabs. The service's
origin restrictions remain unchanged. This extension update adds access for
that exact website; review that access before activating the update. Website
activation follows extension update and public-ID verification. An older
service without paused import is rejected, never retried through automatic
import. If confirmation is lost, check the local workspace before retrying.
Remove and Undo in that workspace reverse a paused queue addition without
deleting an employer draft.

### Download fallback

To transfer selected resumes without the website connection, choose **Download for local C3**
in a ready job's details, or select up to 30 ready jobs and choose **Download
applications for local C3** in bulk actions. This downloads a `.hunt.json` file
containing the selected PDFs, job links, C1 IDs and C2 version names. It does not
queue work or contain connection keys. Keep it private like a resume.

In the local workspace, open **Applications**, expand **Import applications from
Hunt**, choose the file and select **Preview applications**. Check the jobs and
PDF versions. Choose **Add and fill applications** to start a supported queue.
When the file includes a recognized unfamiliar site, choose **Add applications
paused** for the whole file. Preview validates the
PDF checksums and existing queue entries without starting work. Import checks
them again and uses the saved local profile; filling stops before submission.
An unchanged application is reused. A conflicting PDF or source version is
rejected instead of silently replacing the existing entry. Files are limited
to 32 MB total and 5 MB per PDF; export fewer jobs if needed.

The file is a snapshot: later C1 status or C2 edits are not synchronized. Export
again after changing a selected resume. If an import is not confirmed, reconnect
and inspect **Your applications** before previewing and retrying the file.
Existing Pause, Remove and Undo controls remain available for imported entries;
removal does not erase employer drafts. For a local Hunt setup with C3 alongside
its backend, **Retry connection** rechecks the embedded workspace after the
service becomes available, and direct handoff remains available.

With the backend and C3 connected locally, **Fill application** starts queued
preparation for Workday, Greenhouse, Lever, Ashby and Workable. For a recognized
unfamiliar posting, **Send to local C3** stores the job and its selected C2 PDF
as a paused current-page draft. Open its title link in **Applications**, follow
the employer's application link, and choose **Fill current page** in the
extension. C3 checks the posting and binds the selected PDF to the inspected
document. You choose **Next** after reviewing each page.

Bulk handoff accepts up to 30 jobs. Results identify confirmed queued jobs,
paused current-page drafts, and posting links that Hunt could not transfer.
Open any omitted posting yourself. Its selected C2 PDF was not transferred.
Each transferred job retains its C1 ID, C2 version and selected PDF. C1 must have
verified the external posting and C2 must have marked the résumé ready.
Easy Apply jobs remain excluded.

After editing a selected resume, save and compile it in C2. A successful
one-page compile refreshes the selected PDF. A multipage or unknown-page result
blocks handoff until corrected; a failed selection refresh shows a retry warning.
Unsaved edits and failed compiles retain the last good PDF. If the application
already has an older PDF, remove its queue entry and hand off the new selection;
pause it first if it is running. Removal leaves the employer draft intact.
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
remain outside Git. Windows retains encrypted credentials in `account.dpapi`;
other platforms retain them only for the current service session. Protect this
directory as applicant data.
Removed entries retain their saved inputs. **Undo** restores an entry paused,
ready for an explicit retry. Undo history lasts only in the current tab until
reload or eviction by 20 later changes; there is no durable removed-entry list
in the UI. Removal is not permanent deletion of applicant data.

If a request cannot be confirmed, refresh progress and inspect its result before
retrying. A timeout does not cancel work already accepted by C3. Handoff results
keep confirmed, unconfirmed and unsent jobs separate; select only unsent jobs
when retrying a partial batch. Recovery does not automatically replay an action.

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
still pause. Rejected sign-in pauses the job for the owner to check the saved
credentials. If the employer requires a password reset, the owner completes it.

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
Unsupported required controls and additional attachments pause for review. Long
questions and options retain their complete wording in the private backlog; a
bounded internal identifier never becomes an approved wording match. Authorized
fallbacks remain provisional and non-submittable.

### Historical expanded compatibility evidence

This earlier run used fictional profiles. It does not establish current real-profile
coverage or acceptance of later changes.

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

C3.1 is limited to the five supported families. For other sites, use **Fill
current page** and advance through the employer's steps yourself.

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

## Workday sign-in compatibility

Extension 0.1.14 uses Chrome's isolated main-frame scripting API for existing-account
Workday sign-in before attaching the application-filling debugger. It needs website
access to `*.myworkdayjobs.com` and `*.myworkdaysite.com`; it does not inspect password
manager frames. Reload the extension after updating it.

The selected job, tab and document are checked before credential writes. Both fields
are verified again before a single Sign In click. A lost response, changed form,
security challenge or rejected sign-in pauses the draft rather than repeating account
access. For a new account, C3 can create it and check the configured mailbox for
employer verification. Password recovery requires the owner. If Workday opens
the application and Chrome then protects another extension on that tab, C3
reports the browser connection problem and preserves the draft.
Application filling still stops for review before submission. Compatibility with a
particular password manager requires a live check; fixture coverage alone is not proof.

### Reloading the paired extension

From extension 0.1.15, `hunt_extension_reload` reloads Hunt through Chrome's own
`runtime.reload()` API. The authenticated local endpoint is
`POST /browser/extension/reload` with an empty JSON object. It refuses active C3
work and checks for a new extension instance with the same ID after reconnecting.
It preserves the installed folder, pairing, profile, tabs and drafts. It does not
install updates or grant new permissions. The first update adding this capability
still needs one manual Chrome reload; refresh an existing MCP connection to see
the additional tool.

The same operation is available without refreshing MCP through
`node executioner/scripts/reload-extension.ts <C3-data-folder>`. The script reads
the existing local pairing key internally and never prints it.

Client-held resume attachments are distinguished from completed remote uploads. When
a site consumes its file input, C3 verifies the selected file bytes and the same owned
attachment completion before accepting draft readiness. This is not a server receipt.
