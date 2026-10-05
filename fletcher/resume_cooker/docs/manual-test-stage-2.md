# Stage 2 Owner Manual-Testing Backlog

These Tier 3 checks collect owner feedback after Stage 2 Tier 2 acceptance. They are not
release-blocking.

## Stage 2: Windows PDF Workflow Proven

### RC-002: ATS PDF And Text Workflow

- [ ] Strict ATS artifact owner check
  - Test: Build and validate the public ATS artifact through the supported Windows/Docker path.
  - Expected: A one-page ignored PDF and readable ignored text pass strict local and ATS-Checker
    validation without sending content off-machine.

  - [ ] RC-002.2: PDF, page, text, and parser report
    - Prerequisites: Windows 11, Node.js 22+, Docker Desktop with Linux containers, and the isolated
      ATS-Checker environment documented in `WINDOWS_COMPATIBILITY.md`.
    - Steps:
      1. Run `npm run check:tools -- --require-pdf-engine`.
      2. Run `npm run check:local:ats:strict`.
      3. Run `npm run check:testers:strict`.
      4. Open `resume/output/ats.pdf` and confirm selectable text reads in the same section order as
         the visible page.
    - Expected: The PDF is one page; text is readable and ordered; strict reports pass; stable
      reports contain counts/ratios but no raw contact values or extracted text.
    - Notes:

### RC-002.3: Preview And Artifact Separation

- [ ] Current/stale preview owner check
  - Test: Exercise a successful preview followed by a deliberate syntax failure in a scratch source.
  - Expected: Current preview becomes explicitly stale after failure, keeps the last-good temporary
    PDF visible, and never changes the intentional saved PDF.

  - [ ] RC-002.3: Preview lifecycle
    - Prerequisites: Same PDF runtime as RC-002.2 and an unused loopback port.
    - Steps:
      1. Copy `resume/source/ats.tex` to `resume/source/preview-smoke.tex`.
      2. Run `npm run preview -- --source resume/source/preview-smoke.tex`.
      3. Confirm the page reports a current build and displays the PDF.
      4. Add an invalid LaTeX command to the scratch source and select **Build Preview**.
      5. Confirm the page reports stale and still shows the last-good PDF.
      6. Stop with `Ctrl+C`, remove the scratch source, and run `git status --short`.
    - Expected: Server binds to `127.0.0.1`, build IDs change, stale state is visible, shutdown is
      clean, and no PDF/text/report/runtime artifact appears as tracked.
    - Notes:

### RC-003.1 / RC-003.2: Tester Boundary And ATS-Checker

- [ ] Tester evidence owner check
  - Test: Compare normal and strict tester runs.
  - Expected: Optional missing tools are warnings/skips, ATS-Checker actually executes in strict
    mode, and a missing required ATS-Checker environment exits `69`.

  - [ ] RC-003.1: Normalized tester outcomes
    - Prerequisites: Public ATS PDF/text; other tester dependencies may remain absent.
    - Steps:
      1. Run `npm run check:testers`.
      2. Inspect `.runtime/reports/testers-check.json`.
    - Expected: Every adapter has one explicit normalized state; skips and failures never appear as
      executed passes.
    - Notes:

  - [ ] RC-003.2: Strict ATS-Checker agreement
    - Prerequisites: Isolated ATS-Checker environment.
    - Steps:
      1. Run `npm run check:testers:strict`.
      2. Inspect the agreement/count metadata without copying resume content into notes.
    - Expected: ATS-Checker state is `executed_pass`; agreement meets the configured threshold; the
      report says `content_left_machine: false`.
    - Notes:
