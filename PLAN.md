# Hunt Auto-Apply System -- Project Plan

## Overview

Three-component system that scrapes jobs, provides a Chrome extension for manual form filling, and combines both with an auto-applier that navigates job portals and submits applications automatically.

```
hunt/
  hunt.db                        # shared SQLite database (gitignored)
  .gitignore
  README.md
  PLAN.md                        # this file
  setup.bat                      # one-time environment setup
  run.bat                        # run scraper interactively
  run_scheduled.bat              # run scraper via Task Scheduler
  scraper/
    scraper.py                   # main scraping logic
    db.py                        # database layer (shared by applier)
    config.py                    # search terms, filters, watchlist
    requirements.txt             # python-jobspy, pandas, etc.
  extension/
    manifest.json                # Manifest V3 Chrome extension config
    popup.html                   # profile editor UI
    popup.js                     # popup logic, save/load profile
    popup.css                    # popup styling
    content.js                   # form detection + filling on any page
    background.js                # service worker, message passing
    field_map.js                 # keyword-to-field mapping rules
    icons/                       # extension icons (16, 48, 128px)
  applier/
    applier.py                   # main orchestrator (Playwright)
    config.py                    # applier settings, behavior flags
    llm.py                       # Gemini Flash integration
    db_reader.py                 # reads hunt.db, updates job status
    credentials.json             # per-site login email/password (gitignored)
    profile.json                 # personal details (shared with extension)
    answers.json                 # preset Q&A for common questions
    requirements.txt             # playwright, google-generativeai, etc.
    run.bat                      # run auto-applier
```

## Architecture

```
                    +-----------+
                    | scraper/  |
                    | (jobspy)  |
                    +-----+-----+
                          |
                    writes jobs
                          |
                          v
                    +-----------+
                    |  hunt.db  |
                    +-----+-----+
                          |
                   reads new jobs
                   (priority = 0)
                          |
                          v
                  +-------+--------+
                  |   applier/     |
                  |  (Playwright)  |
                  +--+----+-----+--+
                     |    |     |
        launches     |    |     |  calls for
        Chrome with  |    |     |  open-ended Qs
        extension    |    |     |
             v       |    |     v
      +------+--+    |    |  +--------+
      |extension|    |    |  | Gemini |
      | (fills  |    |    |  | Flash  |
      |  forms) |    |    |  | (free) |
      +----+----+    |    |  +--------+
           |         |    |
           v         v    |
      +----+---------+----+---+
      |     Job Portal        |
      |  (Indeed, Workday,    |
      |   Greenhouse, etc.)   |
      +-----------+-----------+
                  |
           updates status
           (applied/failed)
                  |
                  v
            +-----------+
            |  hunt.db  |
            +-----------+
```

## Costs

| Component         | Cost   | Details                                                  |
| ----------------- | ------ | -------------------------------------------------------- |
| Scraper           | $0     | Already working, uses python-jobspy                      |
| Chrome Extension  | $0     | Pure HTML/CSS/JS, no APIs                                |
| Playwright        | $0     | Open source browser automation                           |
| Gemini Flash API  | $0     | Free tier: 1,500 req/day, 15 req/min, 1M tokens/min     |
| CapSolver (later) | ~$0.80 | Per 1,000 CAPTCHA solves, only if needed                 |
| **Total**         | **$0** | Core system is entirely free                             |

## Requirements

### Global

- Python 3.12 or 3.13 (3.14 not supported due to dependency issues)
- Google Chrome browser
- Windows 10+ (bat files are Windows-specific)

### Scraper

- python-jobspy
- numpy, pandas, requests, beautifulsoup4
- tls-client, pydantic, regex, markdownify

### Chrome Extension

- No build tools needed (vanilla HTML/CSS/JS)
- Chrome Manifest V3
- Permissions: `activeTab`, `storage`, `scripting`
- Load as unpacked extension via `chrome://extensions`

### Auto-Applier

- playwright (`pip install playwright && playwright install chromium`)
- google-generativeai (Gemini Python SDK)
- Gemini API key (free, get from https://aistudio.google.com)
- Node.js NOT required (Playwright Python handles everything)

---

# Checklist

## Phase 1: Project Restructure

- [x] Create `scraper/` directory
- [x] Move `scraper.py`, `db.py`, `config.py`, `requirements.txt` into `scraper/`
- [x] Update `DB_PATH` in `scraper/config.py` to resolve to repo root via `__file__`
- [x] Add `sys.path` fix to `scraper/scraper.py` so imports work when invoked from repo root
- [x] Update `run.bat` to run `python scraper\scraper.py`
- [x] Update `run_scheduled.bat` to run `python scraper\scraper.py`
- [x] Update `setup.bat` to install from `scraper\requirements.txt`
- [x] Update `.gitignore` for new structure
- [x] Update `README.md` for new structure
- [x] Verify scraper runs correctly from repo root
- [x] Verify Task Scheduler compatibility (bat file path unchanged)

## Phase 2: Chrome Extension -- Manifest and Scaffolding

- [x] Create `extension/` directory
- [x] Create `extension/manifest.json` (Manifest V3)
  - Name: "Hunt Autofill"
  - Permissions: `activeTab`, `storage`, `scripting`
  - Content scripts: `content.js` on all URLs
  - Background: `background.js` as service worker
  - Action: `popup.html`
  - Keyboard shortcut: Ctrl+Shift+F
  - Externally connectable from localhost (for Playwright)
- [x] Create placeholder `extension/icons/` with 16x16, 48x48, 128x128 icons
- [x] Create `extension/popup.html` skeleton
- [x] Create `extension/popup.css` base styles
- [x] Create `extension/popup.js` skeleton
- [x] Create `extension/content.js` skeleton
- [x] Create `extension/background.js` skeleton
- [x] Create `extension/field_map.js` skeleton
- [ ] Load extension in Chrome as unpacked and verify it loads without errors

## Phase 3: Chrome Extension -- Profile Editor (Popup)

- [ ] Build profile form in `popup.html` with sections:
  - Personal: first name, last name, email, phone, address, city, province, postal code, country
  - Online: LinkedIn URL, GitHub URL, portfolio URL
  - Work authorization: Canadian citizen/PR/work permit status
  - Education: school name, degree, field of study, graduation date, GPA
  - Experience: most recent job title, company, start/end dates, description
  - Preferences: desired salary, willing to relocate (yes/no), available start date
  - Resume: file path to PDF resume on disk
- [ ] Implement save to `chrome.storage.local` in `popup.js`
- [ ] Implement load from `chrome.storage.local` on popup open
- [ ] Add export profile to JSON file button
- [ ] Add import profile from JSON file button
- [ ] Style the popup to be usable (scrollable, sectioned)

## Phase 4: Chrome Extension -- Field Detection and Mapping

- [ ] Build keyword map in `field_map.js` covering:
  - `email` -> ["email", "e-mail", "email_address", "emailAddress"]
  - `phone` -> ["phone", "telephone", "mobile", "cell", "phone_number"]
  - `firstName` -> ["first_name", "firstName", "fname", "given_name"]
  - `lastName` -> ["last_name", "lastName", "lname", "surname", "family_name"]
  - `fullName` -> ["full_name", "fullName", "name", "your_name"]
  - `address` -> ["address", "street", "address_line", "street_address"]
  - `city` -> ["city", "town", "municipality"]
  - `province` -> ["state", "province", "region"]
  - `postalCode` -> ["zip", "postal", "zip_code", "postal_code", "zipcode"]
  - `country` -> ["country", "nation"]
  - `linkedin` -> ["linkedin", "linked_in"]
  - `github` -> ["github", "git_hub"]
  - `portfolio` -> ["portfolio", "website", "personal_website", "url"]
  - `school` -> ["school", "university", "college", "institution"]
  - `degree` -> ["degree", "education_level"]
  - `fieldOfStudy` -> ["major", "field_of_study", "discipline", "program"]
  - `gpa` -> ["gpa", "grade", "cgpa"]
  - `graduationDate` -> ["graduation", "grad_date", "expected_graduation"]
  - `salary` -> ["salary", "compensation", "desired_salary", "expected_salary"]
  - `startDate` -> ["start_date", "available_date", "availability"]
  - `resume` -> ["resume", "cv", "curriculum"]
  - `coverLetter` -> ["cover_letter", "cover", "coverletter"]
- [ ] Build detection function that scores each form field against the keyword map
  - Check `name`, `id`, `placeholder`, `aria-label`, `autocomplete` attributes
  - Check associated `<label>` text (via `for` attribute or parent label)
  - Handle partial matches and case-insensitive comparison
- [ ] Handle ATS-specific patterns:
  - Workday: `data-automation-id` attributes
  - Greenhouse: `#s2id_*` select2 dropdowns, specific field IDs
  - Lever: `.application-*` class patterns
  - Taleo: `#requisitionDescriptionInterface` patterns
  - Indeed: `#applicant.*` patterns
- [ ] Handle `<select>` dropdowns (match option text to profile values)
- [ ] Handle radio buttons and checkboxes (yes/no, work authorization, etc.)
- [ ] Handle file upload inputs (resume, cover letter)

## Phase 5: Chrome Extension -- Content Script (Form Filler)

- [ ] Implement `fillForm()` function in `content.js`:
  - Load profile from `chrome.storage.local`
  - Find all visible form fields on the page
  - Run field detection from `field_map.js`
  - Fill each matched field with the corresponding profile value
  - Dispatch `input`, `change`, and `blur` events after filling (required for React/Angular forms)
  - Handle Shadow DOM elements (some ATS use web components)
- [ ] Add keyboard shortcut trigger (e.g., Ctrl+Shift+F)
- [ ] Add toolbar icon click trigger via `background.js` message
- [ ] Show visual feedback: highlight filled fields in green, unfilled in yellow
- [ ] Handle multi-page forms (re-trigger on page navigation)
- [ ] Test on:
  - [ ] Indeed apply page
  - [ ] LinkedIn Easy Apply modal
  - [ ] A Workday application page
  - [ ] A Greenhouse application page
  - [ ] A Lever application page
  - [ ] A generic company career page

## Phase 6: Chrome Extension -- Background Service Worker

- [ ] Implement message listener in `background.js` for:
  - `FILL_FORM` -- triggers content script to fill the active tab
  - `GET_PROFILE` -- returns stored profile data
  - `SET_PROFILE` -- updates stored profile data (used by Playwright)
- [ ] Implement external message listener (`chrome.runtime.onMessageExternal`)
  - Allows Playwright to communicate with the extension via Chrome DevTools Protocol
- [ ] Handle extension icon badge (show fill count or status)

## Phase 7: Auto-Applier -- Setup and Config

- [ ] Create `applier/` directory
- [ ] Create `applier/requirements.txt`:
  - `playwright`
  - `google-generativeai`
- [ ] Create `applier/config.py` with settings:
  - `DB_PATH` -- path to `../hunt.db`
  - `EXTENSION_PATH` -- path to `../extension`
  - `PROFILE_PATH` -- path to `profile.json`
  - `CREDENTIALS_PATH` -- path to `credentials.json`
  - `ANSWERS_PATH` -- path to `answers.json`
  - `RESUME_PATH` -- path to resume PDF
  - `GEMINI_API_KEY` -- from environment variable or `.env` file
  - `DELAY_BETWEEN_APPS` -- seconds to wait between applications (default 30)
  - `MAX_APPS_PER_RUN` -- maximum applications per session (default 50)
  - `DRY_RUN` -- default False, set via CLI flag
- [ ] Create `applier/credentials.json` template:
  ```json
  {
    "default": {"email": "", "password": ""},
    "indeed.com": {"email": "", "password": ""},
    "workday.com": {"email": "", "password": ""},
    "linkedin.com": {"email": "", "password": ""}
  }
  ```
- [ ] Create `applier/profile.json` template (same schema as extension profile)
- [ ] Create `applier/answers.json` template:
  ```json
  {
    "work_authorization": "Yes, I am authorized to work in Canada",
    "sponsorship_needed": "No",
    "willing_to_relocate": "Yes",
    "available_start_date": "Immediately",
    "years_of_experience": "0-1",
    "education_level": "Bachelor's",
    "gender": "Prefer not to say",
    "race_ethnicity": "Prefer not to say",
    "veteran_status": "No",
    "disability_status": "Prefer not to say",
    "how_did_you_hear": "Job Board"
  }
  ```
- [ ] Add `credentials.json` and `.env` to `.gitignore`
- [ ] Create `applier/run.bat`
- [ ] Install Playwright and Chromium: `playwright install chromium`

## Phase 8: Auto-Applier -- Database Reader

- [ ] Create `applier/db_reader.py`:
  - `get_new_non_priority_jobs()` -- `SELECT * FROM jobs WHERE status = 'new' AND priority = 0`
  - `get_new_priority_jobs()` -- `SELECT * FROM jobs WHERE status = 'new' AND priority = 1`
  - `update_status(job_id, status)` -- set to `applied`, `failed`, `skipped`, or `review`
  - `get_apply_stats()` -- count by status for progress reporting
  - Reuse `DB_PATH` logic from scraper config (resolve relative to repo root)

## Phase 9: Auto-Applier -- Gemini LLM Integration

- [ ] Create `applier/llm.py`:
  - Initialize Gemini Flash client with API key
  - `generate_answer(question, job_description, profile)` function:
    - System prompt: "You are filling out a job application. Answer concisely and professionally."
    - Sends: the question text, job title + company + description, your profile/resume summary
    - Returns: a short tailored answer (1-3 sentences for text fields)
  - Handle rate limiting (15 req/min on free tier, add retry with backoff)
  - Handle API errors gracefully (fall back to leaving field blank)
  - Cache answers for identical questions across applications
- [ ] Test with sample questions:
  - "Why do you want to work at [Company]?"
  - "Describe a challenging project you worked on"
  - "What are your career goals?"

## Phase 10: Auto-Applier -- Playwright Orchestrator

- [ ] Create `applier/applier.py` main script:
  - Parse CLI args: `--dry-run`, `--max-apps N`, `--delay N`, `--priority-only`
  - Load config, credentials, profile, answers
  - Query DB for target jobs
  - Launch Chromium via Playwright with extension loaded:
    ```python
    context = browser.new_context(
        user_agent="...",
        args=[
            f"--load-extension={EXTENSION_PATH}",
            "--disable-extensions-except=" + EXTENSION_PATH,
        ]
    )
    ```
- [ ] Implement navigation flow per job:
  1. Open `apply_url` in a new page
  2. Wait for page load
  3. Detect if redirected to login/signup page
  4. If login needed: fill email + password from credentials, submit login
  5. If signup needed: fill email + password, handle verification if possible
  6. Navigate to application form
  7. Trigger extension form fill via Chrome DevTools Protocol message
  8. Wait for fill to complete
  9. Scan for unfilled required fields
  10. For yes/no or multiple-choice fields: match against `answers.json`
  11. For open-ended text fields: call Gemini via `llm.py`
  12. For file uploads: upload resume PDF
  13. If `--dry-run`: screenshot the filled form, skip submit
  14. If not dry-run: click submit button
  15. Verify submission (check for success message or redirect)
  16. Update job status in DB
  17. Wait `DELAY_BETWEEN_APPS` seconds
- [ ] Implement login detection:
  - Check URL for patterns: `/login`, `/signin`, `/sign-in`, `/auth`
  - Check page content for "Sign in", "Log in", "Create account" text
  - Check for email/password input fields
- [ ] Implement submit button detection:
  - Look for `<button type="submit">`, `<input type="submit">`
  - Match text: "Submit", "Apply", "Submit Application", "Send Application"
  - Avoid "Save", "Next", "Back" buttons
- [ ] Add logging:
  - Console output with progress (e.g., "[3/25] Applying to Software Intern at Shopify...")
  - Optional log file with timestamps, URLs, status, errors
- [ ] Add error handling:
  - CAPTCHA detected: log and skip (mark as `failed_captcha`)
  - Timeout: retry once, then skip
  - Unexpected page layout: screenshot and skip (mark as `failed`)
  - Network error: retry with backoff

## Phase 11: Dry-Run Mode and Testing

- [ ] Implement `--dry-run` flag:
  - Fills all forms but does not click submit
  - Takes a screenshot of each filled form and saves to `applier/screenshots/`
  - Logs what would have been submitted
  - Updates job status to `dry_run` instead of `applied`
- [ ] Test full flow on 3-5 real job postings:
  - [ ] Indeed direct apply
  - [ ] Workday portal
  - [ ] Greenhouse hosted page
  - [ ] Lever hosted page
  - [ ] LinkedIn Easy Apply (if feasible)
- [ ] Verify no duplicate applications (check DB status before applying)
- [ ] Verify delay between applications works
- [ ] Verify Gemini answers are reasonable

## Phase 12: Polish and Documentation

- [ ] Update `README.md` with full setup instructions for all 3 components
- [ ] Add usage examples for:
  - Running scraper
  - Installing Chrome extension
  - Running auto-applier with dry-run
  - Running auto-applier for real
- [ ] Add troubleshooting section for common issues:
  - Extension not loading
  - Playwright Chrome path issues
  - Gemini rate limiting
  - CAPTCHA blocking
- [ ] Update `.gitignore` for all sensitive and generated files
- [ ] Final review of all code

---

## Status Key

- [x] = Done
- [ ] = Not started
- For in-progress items, add a note in parentheses

## Current Status

**Phase 1 complete.** Scraper restructured into `scraper/` subfolder. All bat files updated. Task Scheduler compatible.

**Phase 2 complete.** All extension skeleton files created. Manifest V3 configured. To verify, load as unpacked extension in `chrome://extensions` (enable Developer Mode, click "Load unpacked", select the `extension/` folder).
