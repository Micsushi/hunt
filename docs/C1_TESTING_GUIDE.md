# C1 testing walkthrough

Use this order in your usual Hunt UI. Start with the current profile, then test
changes one at a time. This describes the October 2026 C1 overhaul; it is not a
comparison against a known last-login date.

## What was added or changed

- **Discovery without AI:** C1 uses deterministic searches, page readers and
  eligibility rules across job boards, public feeds and configured employers.
  C2 resume generation is a separate component and can still use AI.
- **Broader source support:** results from JobRight, public feeds and supported
  employer platforms join LinkedIn and Indeed in the searchable Jobs list.
  Source options include sources actually represented in the database.
- **Custom job groups:** search titles can describe occupations outside the
  bundled technology profile. Career levels, countries, employment types,
  remote requirements and senior-role eligibility are independently configurable.
- **Employer preview:** inspect a careers URL, detected hiring platform, sample
  matches and limitations before changing scheduled employer searches.
- **Visible coverage:** Ops reports scan progress and separates catalog coverage
  from descriptions, dates and verified application paths. Partial results,
  blocked sites and rate limits remain visible.
- **Resumable scheduled work:** the runner includes boards, feeds and employers,
  daily backfills, saved progress and a durable JobRight title queue. JobRight
  can resume unfinished titles after a quota or temporary failure.
- **JobRight country selection:** single-country searches use the normal search
  controls for Canada, United States, United Kingdom, Australia, Ireland or New
  Zealand without changing saved JobRight account preferences.
- **Safer settings:** saves are validated and atomic. Reloading shows saved
  values, identifies settings awaiting restart, and preserves earlier changes
  when a second section is saved. Invalid numeric values are rejected.
- **Consistent eligibility and history:** retained jobs are reclassified when the
  effective profile changes. Excluded and duplicate observations remain available
  for audit; application history is preserved. Closed jobs release employer-cap
  slots, and excluded/applied/canceled jobs stay out of automatic downstream work.
- **Verification and recovery:** public postings are checked for identity,
  description and application route. Confirmed removal differs from a temporary
  error; eligible transient failures remain retryable, including slower retries
  after the normal attempt limit.
- **Smaller shared machinery:** duplicated policy/enrichment logic was removed,
  and C2-only Chroma was removed from C1's runtime dependencies. The overall code
  base also gained platform readers; this is not a claim of a net reduction in
  total repository lines.

Your Google Sheet automation remains separate and unchanged. C1 does not import,
update or synchronize its rows. C1 discovering or enriching a job does not submit
an application.

## Before starting

Open **Jobs**, **Ops**, and **Settings → C1 discovery** in separate tabs. Record
three existing job IDs: one relevant job, one excluded or incomplete job, and an
applied/canceled job if you have one. Copy your current C1 settings before changing
them. Use these same examples throughout so you can tell what changed.

A running scheduler can add jobs while you test. Compare IDs and filter behavior,
not an exact total that must remain frozen. If Ops reports a scan in progress,
observe it before starting another. Record results as **Pass**, **Fail**, or
**Not observed**; an example missing from today's results is not a pass.

## First pass: inspect the current profile

### 1. Open the updated screens

Open **Ops**. Find **Search boards, feeds and companies**, **Enrich 25**,
**Search coverage**, and **Preview an employer**. Open **Settings** and select
**C1 discovery**, rather than the C2 tab.

**Pass:** the controls load, the current configuration is visible, and there are
no persistent authentication or loading errors. If the old UI appears, reload
the page before testing further.

### 2. Search the saved jobs

In **Jobs → Search**, enter a title you can already see in the list. Replace it
with an employer's name, then a distinctive phrase from a job description.
Clear the search afterwards.

**Pass:** matching rows appear and clearing the search restores the broader
list. This searches saved jobs; it does not start an internet search.

### 3. Combine source and result filters

Choose JobRight or an employer source that is present in the source list. Add a
status and category filter, change sorting, open a result, then return to the
list. Reset the filters when finished.

**Pass:** every displayed row fits the selected filters, navigation remains
usable, and reset removes the filters. A source with no saved jobs need not
appear. No results under a restrictive combination is a valid outcome.

### 4. Inspect descriptions and application destinations

Open three jobs from different available sources. Compare title, company,
location, posting date, description and application URL with the original
posting. Open the original link to read it; do not submit an application.

**Pass:** the fields refer to the same posting. Missing dates and descriptions
remain missing or incomplete. A board-generated summary must not be passed off
as the employer's complete description. A saved lead alone is not proof that its
application route has been verified.

### 5. Understand exclusions and preserve history

Inspect your excluded example and its discovery explanation. Where examples are
available, check a senior-role exclusion, a geographic mismatch and Easy Apply.
Reopen your applied/canceled example and note its status and history.

**Pass:** exclusions are explained and retained records can still be inspected.
Easy Apply remains excluded from the external-application workflow. An exclusion
must not erase prior application history. Do not change job status just to create
a test example.

### 6. Read scan progress and coverage

In **Ops**, expand **Search coverage** and, during a scan, **Currently searching**.
Observe completed steps, elapsed time and last saved progress. Compare coverage
outcomes with description, date and application-verification counts.

**Pass:** progress updates and incomplete sources stay visibly incomplete. A
completed scan is not a promise that every source was exhaustive or every saved
job is ready to apply to. Record the source and error for unexpected failures.

### 7. Preview an employer without adding it

Expand **Preview an employer**. Enter a real company name and its official public
careers URL, then click **Preview jobs**. Read the platform, sample jobs and any
limits. If multiple published boards are offered, inspect the choices.

**Pass:** the response says **Nothing has been saved**. A supported catalog can
show matching jobs or an explicit no-match result. Unsupported, ambiguous or
blocked sites explain the limitation instead of claiming complete coverage.
An empty preview does not by itself prove the employer has no openings.

## Second pass: run discovery and enrichment

### 8. Run one complete discovery request

When no scan is running, click **Search boards, feeds and companies** once. This
requests a 14-day backfill. Watch progress, then revisit Jobs after results begin
arriving. If the scheduler already owns the scan, let it finish instead of
repeatedly clicking the button.

**Pass:** the request starts or clearly reports that a scan is already running.
Results appear progressively, and the run eventually leaves the running state.
A backfill can take substantial time across many titles and employers.

### 9. Check JobRight progress and limits

Inspect the JobRight coverage entries and saved JobRight jobs after the scan.
Look for completed searches, page-limit warnings, temporary failures or an hourly
quota notice. Check again after a later scheduled cycle if work was deferred.

**Pass:** an unfinished title is retained for retry. A quota does not erase saved
results or mark unsearched titles complete. Four-page query limits remain partial.
Do not expect an hourly-quota test to be reproducible on demand, and do not
repeatedly refresh JobRight to manufacture one.

### 10. Enrich a small batch

After discovery is idle, click **Enrich 25**. Revisit affected pending/incomplete
jobs, inspect their descriptions and application destinations, and read any
failure reasons. Leave **Enrich up to 500** until the small batch behaves as
expected.

**Pass:** eligible jobs gain verified information, while missing, removed or
mismatched postings fail visibly. The action may process fewer than 25 jobs if
fewer are ready. It does not submit applications or guarantee 25 successes.

### 11. Check repeat scans, duplicates and history

Revisit the job IDs recorded at the start after another completed scheduled scan.
Compare their details and history. Where the same posting appeared through
multiple sources, inspect whether redundant active copies are excluded.

**Pass:** repeat observations update the existing posting or identify a duplicate
without losing history. Deduplication is based on posting identity, not merely
identical titles; two distinct requisitions with the same title can remain.

## Third pass: change settings and reverse them

Settings experiments affect future scheduled searches and can reclassify retained
jobs. Change one group at a time and restore it before trying the next group.
Saving is separate from activation: **C1 and its scheduler must be restarted**
when the page says a restart is required. There is no restart button on this
Settings page. Use the deployment's normal operator restart procedure; preserve
its active release overrides. Have the restart performed before judging results.

### 12. Verify saving, reloading and a second save

In **Run settings**, record **Enrichment batch limit**, choose another positive
whole number, and click **Save run settings**. Reload. In **Filters**, append the
unlikely phrase `c1 acceptance test phrase` to **Title blacklist**, then click
**Save filters** and reload again.

**Pass:** both changes remain saved; saving Filters does not revert the batch
limit. A restart notice identifies the activation boundary. Restore the original
batch limit and remove the test phrase, save both sections, and reload. Complete
any required restart with the restored settings.

### 13. Reject invalid numbers

Clear **Max parallel workers** and click **Save run settings**. Repeat with `-1`
and `1.5`. Reload after each rejected attempt, then restore the original value.

**Pass:** the browser or app rejects the input, provides an understandable error,
and retains the last valid saved configuration. The invalid value must not
silently become zero or a different valid number.

### 14. Search another occupation

Record all search groups. In **New job group**, enter `Accounting`, click
**Add job group**, and enter `accountant` in its search-query field. Click
**Save search config**. After activation, run discovery and inspect matching jobs
and their category. A retained job can be used to check reclassification.

**Pass:** the custom group works through the ordinary discovery and policy path,
without an AI prompt or company-specific rule. Results must still meet the other
configured filters. An empty result alone does not establish a failure.

**Restore:** clear the test group's query field and save to stop its title queries.
There is no Remove group button; to remove the group itself, restore the original
search mapping through configuration or the operator API. Restore any other
edited groups and reactivate the original profile. Check that your baseline job
history survived.

### 15. Check career level, seniority and title exclusions

If **Career levels** is shown, try one level, then restore the original selection.
Separately test **Include senior and experienced roles**. Inspect matching and
excluded examples after each activation. Keep the title blacklist in view.

**Pass:** selected career levels require corresponding title evidence. No selected
levels means no junior/intern suffix requirement, but the senior-role switch and
blacklist still apply. Enabling senior roles does not override a senior-title
phrase that remains explicitly blacklisted. Legacy search-term profiles may not
show the Career levels controls.

### 16. Check geography and JobRight country selection

Record **Eligible countries**, **Indeed market**, and **Locations**. For a
single-country experiment, use **United States**, an appropriate U.S. location,
and the matching Indeed market. Save and activate, then run discovery. Inspect
actual posting locations and source coverage. Restore all three fields afterwards.

**Pass:** saved settings, search geography and eligibility agree. JobRight uses
the selected supported country without changing its saved account preferences.
Canada-only sources must report or skip their geographic limitation. Empty
countries means eligibility is worldwide; it does not make every source worldwide.
Multi-country JobRight coverage remains explicitly partial.

### 17. Check employment type and remote requirements

Try **Employment types** with `contract`, save and activate, and inspect a known
contract example plus a nonmatching example. Restore it. Separately enable
**Require confirmed remote work** and repeat with a remote and an onsite job.

**Pass:** eligibility follows each rule. Unknown employment type or remote status
is not invented to make a posting pass. Restore the original values and activate
them before leaving the test.

### 18. Add a future employer to scheduled discovery

First complete the read-only preview in step 7. There is currently **no Add
employer button**: persistence is an operator configuration step. Add the name
and verified public careers URL to `company_career_sites` in the active saved
configuration, preserving all existing entries. The configuration API is also
available to operators. Restart C1 and its scheduler, then run discovery.

**Pass:** the employer appears in coverage and supported postings can be found in
Jobs. Multiple published boards need distinct configured entries. An unsupported
platform can still require a reusable platform reader; preview does not promise
that every arbitrary website works automatically. To reverse the test, restore
the original employer mapping and restart. Previously discovered history remains.

## Finish and record the result

### 19. Recheck the normal workflow on a narrow screen

Use a phone-sized window to open Jobs, a job detail, Ops coverage, employer
preview, and C1 Settings. Try text input and opening/closing the expandable panels.

**Pass:** controls and labels remain usable without the whole page scrolling
sideways, and content is not cut off. Then restore your original settings, reload,
and confirm any restart notice is resolved after activation.

### 20. Check the next unattended cycle

Leave the scheduler running with the restored profile. Return later to Ops and
check that another scan completed or is making progress. Revisit your baseline
jobs and history. Confirm your separate Google Sheet automation still behaves
as before; matching row counts between it and C1 are not expected.

**Pass:** work continues without a manual trigger, failures remain actionable,
and the restored settings persist. Restart/resume, closed-posting slot release,
and slower transient retries are also covered by automated checks; do not delete
jobs, kill services or alter live application history to force those scenarios.

For a failure, record: step number, page/action, job ID or source, expected result,
actual result, and time. A screenshot is useful for layout problems. Do not include
passwords or session cookies. Your acceptance is separate from automated tests.

## Known limits to distinguish from regressions

AHS rejects public access/pagination; CGI presents a security checkpoint; Ballard's
catalog does not establish a total; Edmonton's advertised total exceeds the jobs
its pages expose; Convverge has no usable public catalog. These remain visible
coverage gaps. JobRight has hourly refresh quotas, four-page query limits and
partial multi-country/worldwide coverage. Source listings can disappear between
discovery and verification. None of these should be displayed as complete,
verified coverage when the required evidence is missing.
