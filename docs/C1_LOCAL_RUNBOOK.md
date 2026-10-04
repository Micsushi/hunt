# C1 Local Runbook

Human/operator runbook for local C1 work. This is the supported path when you want to run scrape or enrich from your own machine instead of `server2`.

## What this covers

- saving or checking a local LinkedIn browser session
- switching between headless and headful enrichment
- running headed Linux sessions through Xvfb
- running scrape and enrich locally on Windows with `hunter.ps1` or `hunter.cmd`
- proving that C1 classifies a real Easy Apply row as ineligible for external autofill

## Broad discovery and coverage

The Ops page's **Search boards, feeds and companies** action requests a 14-day
backfill. The equivalent local command is:

```powershell
python -m hunter.scraper --backfill --skip-enrichment
```

This uses deterministic Python and headless Playwright, with no AI runtime.
Install the existing Python requirements and the Chromium browser with
`python -m playwright install chromium` before running browser-backed sources.
The Google Sheet automation is independent and is not changed or synchronized.

## New job categories and companies

Set `search_terms` in `hunt_user_config.json` to the categories and title phrases
you want. For example, `{"healthcare": ["registered nurse", "pharmacist"]}` works
across board searches, employer readers and the generic metadata fallback.
Custom phrases match whole words and ignore accents and capitalization. The
unchanged default categories retain their broader technology-role synonyms.
Set `include_experienced_roles` to `true` to include senior titles. The default
remains early-career Canadian discovery; public feeds and several board readers
are Canada-specific. Changing the role categories does not expand their geography.

Add a company name and its public careers URL to `company_career_sites`. Keep
existing entries when adding one, because a nonempty map replaces the bundled
company roster. A published link to a supported hiring platform needs no new
company-specific code. Unrecognized sites can yield leads from standard
`JobPosting` metadata, with same-origin job links and pagination capped at 25
pages. These results remain partial and ineligible for automatic application.

Restart the C1 service and scheduler after changing configuration, then run the
backfill command above or **Search boards, feeds and companies** in Ops. Check
the company's source outcome and its jobs. C1 reclassifies retained jobs when
the effective discovery settings change; application and verification history
stay intact. Unchanged settings avoid a full reclassification. To reverse a settings
change, restore the previous values and restart the same processes.
Collection-valued environment overrides such as `SEARCH_TERMS`, `SITES` and
`COMPANY_CAREER_SITES` use JSON. Malformed JSON stops startup instead of silently
searching a different set of jobs. Invalid saved JSON also stops startup and
cannot be overwritten by a settings patch. Saves replace the file atomically.
Blank scalar environment values use the saved value or built-in default.

If the site has several boards, configure each published URL under a distinct
label. If it publishes neither a supported catalog nor usable metadata, retain
its visible failure and inspect its official careers page for a public board.
A new platform reader belongs to the platform, not a particular company: test
its pagination, posting identity, dates, closed jobs and interrupted requests
before adding it. Do not substitute a successful page load for complete coverage.

Both the local `python -m hunter.runner` command and Docker's `hunter-scheduler`
use the same unattended schedule, including companies, public sources and daily
backfills. The C1 image does not install C2's Chroma dependency or require C0's
backend to finish a scheduled cycle.

C1 initializes its database schema before accepting service requests. Startup
does not run stale-job requeue maintenance or reset application history. Database
initialization errors stop startup instead of leaving a running service whose
queue and coverage endpoints fail.

Canadian occupation codes such as `NOC 65100` do not count as network-operations
roles. QA postings with explicit food-inspection duties and no technical-testing
evidence are marked outside the search lanes. Existing records are retained;
these policy updates do not reset their application or enrichment history.

BMO's careers-page and Workday URLs share an identity only when their published
requisition numbers match. Existing duplicate records and their history remain
stored; redundant active copies are suppressed. This is a BMO-specific mapping,
not a title-based merge of jobs from arbitrary career sites.

`python test.py c1` also includes an opt-in PostgreSQL integration check. Set
`HUNT_TEST_POSTGRES_URL` to a dedicated test database to run it. The check creates
and removes its own uniquely named schema; it does not use existing job tables.
Without that variable, this check is explicitly skipped rather than presented
as PostgreSQL verification.

| Source | Implemented discovery | Remaining limits |
| --- | --- | --- |
| LinkedIn | Public search cards with consecutive page offsets; existing browser enrichment | Public search is not the entire signed-in catalog. Login and site restrictions can interrupt enrichment. |
| Indeed | Consecutive search cursors using the existing JobSpy parser, verified TLS, and existing enrichment | HTTP errors and repeated cursors retain prior leads and report incomplete searches. An end cursor completes that query, not the entire Indeed catalog. |
| Five configured public feeds | Structured listings and dated backfill | A feed is not the employer's full catalog. |
| Job Bank | Public search cards, pagination to the end, and public posting requirements | Checks the posting URL and title before retaining descriptions, and skips postings past their advertised end date. Malformed cards and failed or unsupported detail layouts report partial coverage. Hidden application-status messages are not job descriptions. Application flows remain unverified. |
| Jobs.ca, Techjobs.ca, ITjobs.ca | Browser searches, pagination, descriptions and posting dates where available | Missing details and application links remain explicit. |
| Jobillico | Public search cards, pagination, posting dates where available | Partner redirects and missing details need verification. |
| Built In | Canada searches, pagination, structured descriptions and dates | Employer application links remain unverified. |
| Wellfound | Public Canada directory, descriptions and pagination | Public highlights only, not the signed-in catalog. |
| Eluta | Browser search cards and pagination | Indexing time is not used as posting time; details remain incomplete. |
| TalentEgg | Current keyword-search route and pagination | Relative dates are not treated as precise timestamps; details remain incomplete. |
| GC Jobs | Public catalog and pagination, with stable advertised totals and unique posting IDs; excludes expired closing dates | A complete catalog with no profile matches reports success. Matched leads retain unverified dates and application links. Government employers can use the official GC Jobs search URL; previews require a normal scan. General FSWEP inventory is not a specific job. |
| VanHack | Public scroll catalog through its explicit end marker, plus posting descriptions | Interrupted scrolling retains loaded cards and reports incomplete coverage. Relative dates are not exact posting dates, so recency remains unverified. Talent Spotlight showcase programs are not treated as jobs. |
| Employer sites | Workday, Greenhouse, Lever and Ashby public catalogs; SuccessFactors HTML search pages; published ATS links on employer directories or job details, including links embedded in page data | Uses `company_career_sites` when nonempty, otherwise bundled employer catalogs. Unresolved public pages get an isolated headless-browser check. Other providers and ambiguous board links remain in the manual queue. |
| Shopify | Published/listed records matched to visible career links, with descriptions from each public posting's page data | Checks posting ID, title, publication status and listed visibility. Missing catalog records or failed details report partial coverage; closed and unlisted details are excluded. Application routes remain unverified. Broad regions such as Americas remain location-unverified, not confirmed Canadian jobs. |
| Amazon / AWS | Public search catalog with descriptions and qualifications, paged to its reported total | Uses configured countries, checks posting paths and IDs, duplicates and stable totals. Missing pages, count changes and missing descriptions report partial coverage. Application routes remain unverified. |
| SmartDreamers | Published search configuration and complete public catalog, with employer posting details | Checks exhaustive counts, pagination, requisition IDs, same-site posting URLs and detail titles. Missing publication dates stay unknown. Application routes remain unverified. |
| Critical Mass | Employer-owned embedded catalog and descriptions, restricted to its published Canadian roles | Does not scan the shared parent-company ATS board. Checks posting host, board and requisition identity. Matching roles with no posting date remain partial; the published last-updated date is not treated as a posting date. Application routes remain unverified. |
| JazzHR | Public listing pages, published next links, and structured posting descriptions | Checks posting URL and title, dates, expiry and remote applicant-country requirements. Missing or failed details, repeated pages and invalid pagination URLs report incomplete coverage. Application routes remain unverified. |
| HiBob | Catalog response from the normal public page in an isolated headless browser | Checks the visible listing total, unique posting IDs, descriptions and original publication dates. Uses published job-link format. Missing details or dates report incomplete coverage; application routes remain unverified. No saved user profile is used. |
| Okta / Auth0 | Public employer directory, published next links, and full posting articles | Checks canonical URL, article identity, title, original date and expiry. Does not substitute the shortened search-engine description for the full article or read application fields as job content. Missing details, repeated pages and invalid next links report incomplete coverage. Application routes remain unverified. |
| Capgemini | Published Canadian job feed with page/count checks and employer posting details | Uses the feed because the hiring-board location search can omit published Canadian postings. Verifies canonical URL, title and Canadian location; reads original posting dates and full descriptions rather than feed update times. Closed and expired postings are skipped; missing details or changing/repeated pages report incomplete coverage. Application routes remain unverified. |
| Eightfold career sites | Shared public search/detail reader; employer identifier read from the published page | Searches Canada, follows offsets to the reported total and checks unique posting IDs, employer detail URLs and titles. Uses published posting dates, not record-creation dates. Missing details and unstable or repeated pages report partial coverage. Application routes remain unverified. |
| Google | Public Canadian results, published next-page links, full qualifications, description and responsibilities | Checks reported totals, unique IDs and employer detail identity. The observed pages do not provide reliable publication dates, so leads remain date-unknown and coverage is partial rather than claiming a complete recent-job search. Application routes remain unverified. |
| TalentBrew | Public search tables and their published pagination endpoint, plus structured posting details | Checks page numbers, total rows, duplicate URLs and detail titles/URLs. Disabled next links end the search. Missing dates/details or paging failures retain earlier leads and report partial coverage. Application routes remain unverified. |
| iCIMS | Public listing iframe, numbered page controls and structured posting details | Checks page progression, stable page count, unique IDs, posting URL/title, country, date and expiry. Unsupported or empty page layouts report incomplete coverage. No account is required for this public discovery path; application routes remain unverified. |
| UKG / UltiPro | Catalog responses and the normal “View More Opportunities” control, plus structured data in public posting pages | Checks request offsets, stable filters and totals, unique posting IDs, title/requisition identity, full descriptions and closed status. Failed pagination preserves earlier pages and reports partial coverage. The same posting on multiple boards for one tenant has one canonical identity. Application routes remain unverified. |
| SmartRecruiters employers | Public Posting API, all reported catalog pages, matching Canadian or location-unverified leads, full description sections | Overlapping pages, changing totals and excess rows fail the completeness check. Failed details retain the lead with partial source health. Application routes remain unverified. |
| Workable widgets | Public account feed referenced by the employer's widget, including its full-description option | Decodes the callback payload as JSON without executing it. Covers the published widget feed; missing descriptions report partial coverage. Application routes remain unverified. |
| Workable directories | Published employer directory, continuation-token pagination, description/requirements/benefits | Excludes internal and unpublished records. Missing pages or failed details retain earlier leads and report partial coverage. Application routes remain unverified. |
| Teamtailor directories | Published “Show more” pages and structured posting descriptions | Requires matching posting identifiers; expired records are skipped. Detail failures retain unverified leads. Application routes remain unverified. |
| Oracle Candidate Experience | Public Canada search through its reported total, secondary locations, and full posting details | Uses a published Oracle board URL or a custom careers page's explicit Oracle configuration. Repeated or missing pages report partial coverage; detail failures retain leads. Expired postings are skipped. Application routes remain unverified. |
| BambooHR | Public careers feed, listing-count check, open posting details, descriptions and posting dates | Explicit job locations override office addresses. Closed jobs are skipped; missing details or count discrepancies report partial coverage. Application routes remain unverified. |
| IBM | Public Canadian search index, all reported pages, full details read in an isolated headless browser | Matches posting ID and title before accepting details. Explicit closed-job redirects are excluded. Failed details retain blocked leads with partial source health. Search snippets are not full descriptions; unknown posting dates stay unknown. Application routes remain unverified. |
| Phenom (OpenText and Demonware verified) | Published public search and detail endpoints, Canadian country facet, recent-first pagination | Requires matching posting IDs, titles, external visibility and full descriptions. Repeated pages or changing totals report partial coverage. Application routes remain unverified. |
| Paradox career sites | Public catalog pages, reported total checks, published next-page links and structured posting details | Requires external visibility and matching posting URL, title and requisition ID. Repeated or missing pages report partial coverage. Expired details are excluded; failed details retain blocked leads. Application routes remain unverified. |
| Avature (National Bank layout) | Public search tables, reported totals, next-page links, posting dates and role/benefit sections | Matches posting ID and title. Uses job-specific map locations and published location labels, not employer headquarters. Failed details remain blocked and source health becomes partial. Application routes remain unverified. |
| Rippling | Public server-rendered catalog pages and full company/role descriptions | Checks board identity, page totals, unique posting IDs and detail titles. Unlisted or failed details remain blocked and report partial coverage. Uses the published creation date; application routes remain unverified. |
| Kula | Public rendered catalog and structured job descriptions | Requires catalog IDs to match visible job links, external visibility, and matching detail IDs/titles. Missing or conflicting records fail coverage; expired details are excluded. Application routes remain unverified. |
| Pinpoint | Published unpaginated feed and structured posting details | Requires pagination explicitly disabled, same-host posting URLs, unique IDs and matching detail titles/IDs. Paginated layouts report unsupported coverage. Expired jobs are excluded; failed details remain blocked. Application routes remain unverified. |
| ADP Workforce Now | Public career-center catalog, one-based paging, full descriptions and posting dates | Checks totals, external visibility and detail identity. The verified Userful catalog omits job locations; these remain unknown rather than using the employer's office list. Application routes remain unverified. |
| Dayforce | Catalog responses from the normal public page and numbered pagination controls in an isolated headless browser | Checks requested board, tenant, request offsets, unique posting IDs, descriptions and stable totals. Failed or unsupported pagination retains earlier pages and reports partial coverage. Missing locations remain unknown. No saved user profile is used; application routes remain unverified. |
| JobRight | Searches each configured title through the normal interface, selects Most Recent and reads up to four batches per query | Requires a saved session or dedicated browser. Reports each query separately; page limits, missing dates, country mismatch and account limits remain incomplete. Does not change saved preferences. |
| Paycor / Newton | Published career-list rows and full employer descriptions, with matching tenant, posting ID and title | This layout provides no catalog total or posting dates, so coverage remains partial. Does not enter or submit the application form. |
| Apple | Public Canadian search pages to the reported total, matching visible posting links and page data, then full descriptions and qualifications | Checks unique posting IDs, titles, external visibility, stable totals and original dates. Failed details remain unverified leads and report partial coverage. Does not sign in or start an application. |
| HRsmart | Public job tables, reported totals, published next-page links, opening dates and full descriptions | Checks matching requisition IDs and titles. Missing pages or details report partial coverage. Closing dates are not substituted for opening dates; application routes remain unverified. |
| PeopleSoft Fluid | Anonymous public search, ordinary scrolling through all reported results, posting dates and full descriptions | Checks catalog totals and matching job IDs/titles. Uses an isolated headless browser, not an AI agent or saved applicant account. Incomplete scrolling, missing details and access failures remain visible; no applications are started. |
| Recruitee | Public English catalogs, rendered totals and published posting links, plus structured descriptions and posting dates | Checks board host, published status, unique job IDs, title and employer identity. Catalog/detail mismatches report incomplete coverage; application routes remain unverified. |
| Technomedia / Cegid (WorkSafeBC) | Anonymous search table and full posting pages | Checks the table count against the posting navigation total. Reads opening dates, not closing dates; changing navigation tokens do not create duplicate jobs. Incomplete catalogs and missing details remain visible. |
| SAP (BC Hydro) | Anonymous keyboard-paged catalog and public PDF descriptions | Checks row coverage against the published total, posting and PDF identity, dates and complete descriptions. Uses the existing PDF dependency; no account or application is created. |
| SuccessFactors unified RMK (Deloitte) | Public date-sorted search service and full posting pages | Reads all pages, checks unique IDs against the total and validates detail identities. Combines every description section, including requirements; repeated or changing catalogs remain incomplete. |
| Taleo career sections (Edmonton) | Public search pages and posting details, without sign-in | Keeps opening dates distinct from closing dates and verifies title/requisition identity. Reads every exposed page; a published count larger than the returned catalog is reported as incomplete, not silently accepted. |

Employer link resolution first reads public HTML and embedded link data. If no
supported board is found, the normal runner opens an isolated headless browser
and checks the rendered page and at most three relevant same-site links. This
also recognizes successful public Greenhouse catalog requests made by that page;
it does not retain request headers, cookies or unrelated network data. Multiple
distinct boards still require an explicit configuration choice. This
does not use an account profile, log in, or submit forms. HTTP access failures
and ambiguous board links do not trigger this fallback. Browser failures remain
visible in source health rather than being counted as empty catalogs.

SmartRecruiters uses its documented [public Posting API](https://developers.smartrecruiters.com/docs/endpoints).
Lever supports both its global and EU hosting regions through its documented
[public Postings API](https://github.com/lever/postings-api/blob/master/README.md).
Successful catalog retrieval covers that board, not every hiring site a company may operate.
For example, SAP's new careers site also links to an old careers site during its migration;
the new SmartRecruiters catalog alone does not establish full SAP coverage.
Track both sites as separate entries in `company_career_sites`, with distinct
labels such as `SAP / SAP Concur` and `SAP / SAP Concur (legacy careers)`.
The existing company queue then schedules and reports each site independently.
Queue entries use distinct configured labels even when the labels are employer
aliases. For example, `RBC` and `Royal Bank of Canada` can track the main and
early-talent boards separately; their jobs still share RBC's employer limits.

C1 remembers each site's resolved hiring-board address and fetches fresh listings
from it on subsequent runs. Changing the configured careers URL clears that saved
address. If a saved board disappears, changes identity or no longer exposes a
recognized catalog, C1 checks the careers page again for a replacement. An empty
generic fallback also rechecks published platform links. Access failures and rate
limits do not trigger that fallback. Failed recovery preserves the previous error.

Ops shows each search's last outcome, lead count and error, plus unfinished
company checks and sources without adapters. `partial` is not exhaustive coverage.
The source-check list starts with checks needing attention. Choose all checks to
include completed searches, or search by employer, source or error. Each company
appears once using its latest queue outcome.
The Jobs list and job details show discovery-rule results separately from
enrichment status. Duplicate and excluded records remain visible for history.
Passing discovery rules does not mean the application route has been verified.
A page limit, repeated page, missing date or failed request must not be interpreted
as proof that there are no matching jobs. Public-source leads stay blocked from
automatic application until verified. Both the post-scrape pass and the normal
enrichment command or dashboard action can verify
Workday leads against the employer's live single-requisition response: matching
title and requisition, usable description, matching external URL, and explicit
`canApply: true`. This confirms an open external route, not completion of C3's
application journey. Greenhouse, Lever and Ashby leads are checked against their
live published catalogs, requiring an exact posting URL and title, usable full
description and matching application route. Greenhouse pages on employer-owned
domains must publish a matching board link or have a catalog-backed posting link
retained from discovery. Verification still requires an exact live catalog match;
multiple conflicting boards are not guessed. Missing or unlisted postings fail
verification. Each batch fetches a board catalog once; later batches fetch fresh
data. SmartRecruiters leads use the public single-posting response and require
matching employer and job IDs, title, published and application URLs, full
description, `active: true` and `visibility: PUBLIC`. BambooHR leads require a
matching published job URL and title, full description and explicit `Open`
status from the public posting detail response. Workable employer-scoped URLs
use their public detail response, requiring a matching shortcode and title,
published external status, and the full description, requirements and benefits.
Hidden locations are excluded. Unresolved directory links remain unverified.
No application is started
or submitted. Other public providers remain
unverified. Existing Easy Apply exclusions remain unchanged.

Verification refreshes the location from the employer's posting and recalculates
fit. An employer location outside Canada is not treated as Canadian just because
a search board labeled it that way. Missing employer locations remain unverified.
Original posting URLs remain available for repeat verification and deduplication
when an employer publishes a different application URL.

Public verification runs first and shares the configured enrichment batch limit
with the board workers. Its results appear under `public_employer` in the enrichment
summary. It preserves application history, excludes Easy Apply, retries transient
failures after one hour, then retries recognized transport failures once daily
after the enrichment attempt limit. Identity and unsupported-response failures
stop at that limit. Permanently excluded jobs do not occupy the verification
queue; employer-cap and unknown-geography leads can still be checked. Confirmed
removed jobs release employer-month slots immediately. An interrupted claim can be recovered when stale.
An explicit operator requeue to `pending` permits one more public verification
attempt, even after that limit. It does not reset attempt history or authorize
unlimited automatic retries. Applied jobs and Easy Apply rows remain excluded.

Workday catalogs are scanned to the reported end rather than stopping after
1,000 listings. Repeated pages or failed requests still stop with partial coverage.
Recognized SuccessFactors sites use their published search form, follow forward
page links or the published tile-search paging configuration, and retain Canadian search-lane matches with posting dates and full
descriptions where available. Failed detail requests retain the discovered lead
and report partial coverage. Explicit ended-posting notices are excluded. Tile
pages must reach their reported total without duplicates or missing pages.
These postings remain application-unverified.
Public board adapters follow their next-page controls to the end by default;
explicit test page limits remain available and are reported as incomplete scans.
LinkedIn's runner path uses C1's public search reader, not JobSpy pagination.
Offsets advance by the number of received cards, including filtered-out cards.
Repeated pages, unrecognized responses and request failures retain earlier leads
and report incomplete coverage. These leads have no application URL until the
existing enrichment worker resolves one and applies the Easy Apply exclusion.
Indeed's runner path uses C1's cursor loop rather than JobSpy's result-count
slice. It follows the returned cursor until the source ends the query, with no
configured result-count cutoff. The owned request session enforces certificate
validation and raises HTTP errors instead of treating them as empty results.
Both readers preserve the existing enrichment and Easy Apply checks. The legacy
`scrape_single` compatibility helper still uses the original JobSpy batch API;
it is not the normal LinkedIn or Indeed runner path.
Transient public HTTP failures are retried up to three times; authentication,
access denials and long rate-limit backoffs are not bypassed.

The unattended runner checks due public sources hourly and company catalogs every
six hours by default, in addition to the daily 14-day backfill. Failed or partial
company checks are due again after one hour. These are minimum intervals after
completion, not promises of exact start times. Board searches, public sources and
company catalogs run concurrently with their existing request limits; a slow board
does not hold up company results. Saves are serialized to preserve counts and
deduplication. An in-progress scan must still finish before the next runner cycle.
The next-check times persist across restarts; a
database write failure does not mark that source checked. Configure
`public_discovery_interval_seconds` and `company_discovery_interval_seconds` in
the existing user config to change the intervals. Manual backfills force a check
but still respect JobRight's cooldown.

For unattended JobRight runs, save the session after signing in to the dedicated
browser (its debugging endpoint must stay on loopback, never a public interface):

```text
python -m hunter.discovery_jobright --save-session .state/jobright_auth_state.json
```

Set `JOBRIGHT_STORAGE_STATE_PATH` if the private session file is elsewhere.
Containers use `/app/.state/jobright_auth_state.json` from the existing state
volume. The connector launches its own headless browser from that session; the
visible browser can be closed. Only JobRight cookies and storage are exported.
Alternatively, `HUNT_JOBRIGHT_CDP_URL` attaches to an open browser and closes only
its own tab. Session expiration requires signing in again; C1 reports that gap.
JobRight's hourly refresh limit is reported as `rate_limited`; scheduled and
manual C1 runs defer that source for an hour while other sources continue.
Pending titles persist across completed scans, so later titles receive a turn
instead of every hourly run restarting the same list. Changing the query profile
starts a new cycle. Searches cover the browser's current country only; multiple
selected countries or worldwide scope are explicitly reported as partial.
An initial browser load interrupted by `ERR_NETWORK_CHANGED` on a JobRight
document, script or stylesheet receives one reload. Account errors, request
limits and unrelated analytics failures do not trigger that retry. Results are
saved after each completed recommendation page, including before a later limit.

Completed JobSpy batches and public-source batches are saved as they arrive;
Jobillico and Built In save after each search term. Built In fetches each matching
posting once per run, including postings later excluded by date or location.
Jobillico requests date ordering and stops at an older page only when the site
confirms that ordering and every listing has a known date before the cutoff.
Jobs.ca, Eluta and GC Jobs also save incremental browser results. Each completed
employer is saved separately. Bundled catalogs supply company URLs only, not
proof that their historical example jobs are still open. A run can still
lose the current unfinished batch if interrupted. Existing saved search settings
take precedence over the broader Canadian defaults.

## Adding unfamiliar employers

Add the company's public careers URL to `company_career_sites`. C1 first detects
the hiring platform and reuses its existing reader; a new employer using a
supported platform does not need a company-specific module.

If no platform matches, C1 can read published [JobPosting metadata](https://schema.org/JobPosting)
from ordinary HTML. This fallback supports JSON-LD objects, lists, graphs and
item lists. It follows observed same-origin job links and `rel="next"` links,
up to 25 pages per scan. It does not guess addresses, traverse other domains,
invent missing locations or dates, or treat an empty page as a complete catalog.
Its results remain partial and unverified for application. JavaScript-only pages,
login gates and pages without usable job metadata still need platform support
or manual handling. Known platform readers retain their stronger pagination and
identity checks.

The shared metadata reader is also used by Kula, Pinpoint, JazzHR, Okta and
Teamtailor, so fixes to standard metadata shapes apply across those readers.
No AI service or new package is needed for this fallback.

## Prerequisites

- repo checked out locally
- Python environment installed: `.venv` or `venv`
- Playwright browsers installed
- local `.env` filled in if you need custom paths, service token, or Discord webhook
- LinkedIn auth state saved to `.state/linkedin_auth_state.json` if you want LinkedIn enrichment

## Save or check a local browser session

Check whether a saved auth state already exists:

```powershell
.\hunter.ps1 auth-check
```

If auth is missing or stale, save a fresh one in a visible Chrome window:

```powershell
.\hunter.ps1 auth-save
```

Windows cmd version:

```bat
hunter.cmd auth-check
hunter.cmd auth-save
```

Linux/macOS version:

```bash
./hunter.sh auth-check
./hunter.sh auth-save
```

## Headless and headful runs

Default enrichment is headless. Use this for normal unattended checks:

```powershell
.\hunter.ps1 enrich 10 --source linkedin
```

Use headful when you need to watch the browser or debug a blocked row:

```powershell
.\hunter.ps1 enrich 10 --source linkedin --headful
```

Use a one-row visible verification pass when you already know the job id:

```powershell
.\hunter.ps1 enrich --source linkedin --job-id 123 --ui-verify
```

If you want discovery without immediately opening browsers:

```powershell
.\hunter.ps1 scrape --skip-enrichment
```

If you want discovery plus a bounded local enrichment pass:

```powershell
.\hunter.ps1 scrape --limit 5
```

## Linux Xvfb

Use Xvfb when the machine has no desktop but you still need headed Chromium.

One-off shell:

```bash
xvfb-run -a ./hunter.sh enrich 10 --source linkedin --headful
```

Persistent display:

```bash
Xvfb :98 -screen 0 1920x1080x24 &
export DISPLAY=:98
./hunter.sh auth-save
./hunter.sh enrich 10 --source linkedin --headful
```

If the repo is running on the server-shaped systemd setup, you can inspect the service with:

```bash
./hunter.sh xvfb-status
```

## Windows local scrape and enrich

PowerShell path:

```powershell
.\hunter.ps1 queue
.\hunter.ps1 scrape --skip-enrichment
.\hunter.ps1 jobs --source linkedin --status pending --limit 10
.\hunter.ps1 enrich 5 --source linkedin --headful
```

cmd path:

```bat
hunter.cmd queue
hunter.cmd scrape --skip-enrichment
hunter.cmd jobs --source linkedin --status pending --limit 10
hunter.cmd enrich 5 --source linkedin --headful
```

This is local-only. You do not need to deploy to `server2` just to test C1 scraping or enrichment behavior on your own machine.

## Real Easy Apply proof

This is the shortest honest proof that Easy Apply is detected and excluded by C1.

1. Run a real LinkedIn scrape or identify a real pending LinkedIn row:

```powershell
.\hunter.ps1 scrape --skip-enrichment
.\hunter.ps1 jobs --source linkedin --status pending --limit 20
```

2. Pick a real LinkedIn job id that is known to be Easy Apply and enrich it in a visible browser:

```powershell
.\hunter.ps1 enrich --source linkedin --job-id 123 --ui-verify
```

3. Verify the Stage 2 fields:

```powershell
.\hunter.ps1 verify 123 --expect-type easy_apply
```

4. Verify the C1 exclusion invariant:

```powershell
.\hunter.ps1 verify-easy-apply 123
```

Expected result:

- `verify` passes with `apply_type=easy_apply`
- `auto_apply_eligible=0`
- no external `apply_url`
- `verify-easy-apply` passes


## Search profiles and employer onboarding

C1 discovery, eligibility checks, deduplication, saved-job search, and public-posting
verification run without an LLM. An independent Google Sheet automation is a
separate workflow; deploying C1 does not migrate or disable that automation.

The user configuration accepts custom `search_terms` lanes for occupations such
as nursing, teaching, trades, retail, or engineering. Set `locations` for board
queries and `discovery_countries` for eligibility. An empty country list removes
the country eligibility restriction. `country_indeed` selects Indeed's market.
Sources with a regional catalog, such as Canadian public boards, remain regional;
changing eligibility does not create an overseas catalog on those sites.

Optional `career_stages` values are `early_career`, `unstated_stretch`, and
`experienced`. An empty list retains the default stage policy; use
`include_experienced_roles` to include senior roles. `employment_types` accepts
published types such as `FULL_TIME` or `PART_TIME`; punctuation and case are
normalized. `remote_only` requires positive remote-work evidence. Missing
employment or remote evidence is set aside for checking, never invented.
Settings are loaded at process startup, so restart C1 and its scheduler after
saving a search profile.
The settings API returns saved values for editing, an `effective` snapshot of
the running process, and `restart_required`. Saving another section does not
restore old startup values. Numeric settings reject blank, null, fractional,
negative, or out-of-range values before saving.

Preview a new company in Ops, or run:

```text
python -m hunter.company_preview "Example" "https://example.com/careers"
```

A preview saves neither the company nor its jobs. It shows the detected platform,
sample matches, and any limits. It is bounded to 12 requests and a short time
budget, so a large board can require a full scan. Browser-only platforms report
that requirement. If multiple published boards are found, choose the intended
boards explicitly rather than guessing an employer tenant.

`company_career_sites` accepts either one URL or a list of URLs per company:

```json
{
  "company_career_sites": {
    "Example": ["https://jobs.lever.co/example", "https://jobs.lever.co/example-europe"]
  }
}
```

Each board has its own coverage record while jobs retain the original company
name. Full backfills recheck the configured career page for platform migrations;
a temporary marketing-page failure does not discard a working saved board.
Generic pages support JSON-LD and microdata JobPosting records and observed
same-site posting links. Their coverage remains partial unless the employer
explicitly publishes a recognized no-open-roles statement. Empty HTML alone is
never proof of no jobs. Unsupported sites need an official feed or a reader with
fixtures proving pagination, identity, and empty/error behavior.

## Recovery, freshness, and coverage

C1 and the scheduler share a database lease to prevent overlapping scans. The
lease renews while a process is alive and expires after 120 seconds without a
renewal. Completed companies, board searches, and supported public queries are
checkpointed only after saving results. A matching interrupted scan can resume
within 24 hours; changing search settings starts a new scan. An unfinished query
is reread from its beginning, with database deduplication retaining saved pages.
Jobillico and Built In save each parsed page before continuing.

Termination stops new work at request/page boundaries. A request already in
progress may finish or time out. Two public sources and up to four company boards
can run concurrently; existing per-source pacing remains in effect. Access
failures, rate limits, and unsupported platforms receive different retry delays.

Public GET responses with ETag or Last-Modified can be cached. Every reuse needs
origin validation; access failures never fall back to an old cached response.
Private responses and cookies are not cached. Set `HUNT_DISCOVERY_CACHE_DIR` to
choose the cache directory. Removing its `discovery-http.sqlite` file while C1 is
stopped only removes this performance cache, not saved jobs or checkpoints.

Ops shows current searches, elapsed time, completed steps, last saved progress,
and separate description/date/application-verification counts. A complete scan
means its supported catalog was read; it does not prove every lead has a usable
application path. Saved eligible public-employer postings are rechecked after a
day, behind new leads. Confirmed removal disables eligibility; transient failures
remain retryable. Applied jobs and their source history are preserved.


Existing `target_job_titles` and `experience_levels` settings are supported.
Internship, junior and new-graduate choices expand into deterministic search
phrases and require corresponding title evidence. Custom groups support any
occupation. An empty level list searches the role title without level suffixes;
`include_experienced_roles` still controls senior-role eligibility. Explicit
legacy `search_terms` take precedence when both configuration formats exist.
`company_blocklist` excludes exact normalized employer names without deleting
source history. Settings displays the active configuration format.


## Retention, ranking and queue health

The employer-month cap applies only to postings within the last 30 calendar
days (inclusive), grouped by the actual posting month. Older, unknown-date
and future-dated records do not consume a slot. Aging out of the window releases
only the cap exclusion on the next C1 initialization; duplicate and other policy
exclusions remain intact. Applied and canceled history is never deleted.

Custom configured occupations receive equal priority when their titles match.
The bundled technology profile retains its P1/P2/P3 labels. Career-stage,
location, employment and external-application rules still apply independently.

`GET /discovery/health` includes `public_verification.ready_groups`, separating
ready verification work by exclusion reason and verification state, with oldest
discovery and verification timestamps. Jobs passing discovery rules are verified
before excluded jobs; new jobs precede repeat checks within each group. This
changes ordering, not verification requirements or application history.

`geography_limits` identifies Canada-only public sources and the selected
countries they cannot search. Those sources are skipped with a visible explanation
when Canada is not selected; mixed-country searches retain a partial-coverage
warning. Configuring worldwide discovery does not turn regional boards into
worldwide catalogs. Employer-board coverage remains limited to the configured URL.

The separate Google Sheet automation remains active and independent. C1 does
not synchronize spreadsheet rows or alter its saved automation prompt.


## Employer coverage still requiring external evidence

The October 4, 2026 checks found these limits. Keep them visible rather than
reporting the employers as fully searched:

- Alberta Health Services: the public search page is readable, but its published
  pagination route rejects access. A partial first page is not a complete scan.
- CGI: the primary Njoyn board presents a security checkpoint. The alternative
  `cgi.jobs` site loads in an isolated browser, but reports zero jobs even without
  search filters. That does not establish that CGI has no vacancies and is not
  used to replace the primary board.
- Ballard: the published Paycor list has no total or end cursor to establish
  exhaustive coverage. Existing visible postings are still collected.
- Edmonton: the published Taleo total exceeds the unique postings exposed by
  pagination. Preserve those postings and the count-mismatch warning.
- Convverge: the careers page links to LinkedIn and has no usable public catalog
  or explicit statement that there are no openings.

These are source limitations, not completed coverage. No checkpoint is bypassed,
no certificate check is disabled, and no missing date or posting is invented.


## Owner acceptance checklist for the October 2026 C1 update

Follow the [ordered C1 testing walkthrough](C1_TESTING_GUIDE.md). It explains the
new features, exact controls to use, expected results, restoration steps and known
source limits. Start with read-only checks before changing the live search profile.
