# Stage 3 Owner Manual Testing

These Tier 3 checks are optional owner review. None are release-blocking.

- [ ] S3-F1: Independent tester evidence
  - State: not tested
  - Feature test: build the public ATS artifact, enable the isolated tester environments, and run
    normal plus strict tester profiles.
  - Prerequisites: Windows 11, Node 22+, Docker Desktop, Python 3.11, tester environments documented
    in `testers/README.md`.
  - Expected: ATS-Checker, ResumeParser, and ats-screener show actual execution; Resume-Matcher shows
    an explicit deferral; no raw resume/JD values appear.
  - [ ] RC-003.3: ResumeParser structure
    - Test instructions:
      1. Run `npm run build:pdf:ats`, then `npm run check:local:ats`.
      2. Run `npm run check:testers`.
      3. Inspect `.runtime/reports/testers-check.json`.
    - Expected: ResumeParser reports booleans/counts only and state `executed_pass`.
    - Notes:
  - [ ] RC-003.4: ats-screener local score
    - Test instructions:
      1. Install the vendored lockfile as documented.
      2. Run `npm run check:testers`.
      3. Confirm `network_used` is false and no term/suggestion arrays are retained.
    - Expected: Six local profiles execute with bounded numeric evidence.
    - Notes:
  - [ ] RC-003.6: Strict profile
    - Test instructions:
      1. Run `npm run check:testers:strict`.
      2. Temporarily rename the ignored ATS-Checker `.venv`, rerun, then restore it.
    - Expected: Installed strict run passes; missing required ATS-Checker exits `69`.
    - Notes:

- [ ] S3-F2: Postflight regression evidence
  - State: not tested
  - Feature test: run the public valid/failing fixture commands in `docs/comparison-contract.md`.
  - Prerequisites: public ATS PDF/text artifacts; Poppler or healthy Docker.
  - Expected: valid fixture passes, fact/JD regressions fail with exit `2`, and reports contain no raw
    fact values or absolute host paths.
  - [ ] RC-004.2 / RC-004.3 / RC-004.4: Fact, strength, and grounding cases
    - Test instructions:
      1. Run valid, fact-change, strength-loss, omission, grounded, and ungrounded fixture cases.
      2. Compare status to `fixtures/compare/manifest.json`.
    - Expected: statuses match the manifest and only IDs/counts/field types appear.
    - Notes:
  - [ ] RC-004.5 / RC-004.6: PDF and report contract
    - Test instructions:
      1. Run `npm run compare:fixtures`.
      2. Inspect `.runtime/reports/compare-fixtures.json`.
    - Expected: one-page, extraction, section/order, encoding, and parser checks execute; schema is
      `1`; content-left-machine is false.
    - Notes:
