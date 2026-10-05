# Stage 1 Owner Manual-Testing Backlog

These Tier 3 checks collect owner feedback after Stage 1 Tier 2 acceptance. They are not
release-blocking.

## Stage 1: Foundation Healthy

### RC-001: Truthful Tool And Engine Detection

- [ ] Capability and PDF workflow owner check
  - Test: Compare unavailable and usable toolchain behavior on an owner-controlled host.
  - Expected: Tool status is truthful, failures are actionable, and successful builds produce a
    non-empty ignored PDF.

  - [ ] RC-001.1: Capability probes
    - Prerequisites: Node.js 22+ and, optionally, Docker.
    - Steps:
      1. Run `npm run check:tools`.
      2. If Docker is installed, compare the result with Docker Desktop or daemon state.
    - Expected: Installed and usable are distinct; a stopped/unreachable daemon never appears
      usable.
    - Notes:

  - [ ] RC-001.2: PDF engine selection
    - Prerequisites: One usable TeX engine or Docker runtime.
    - Steps:
      1. Run `npm run build:pdf:ats`.
      2. Confirm the command names the selected engine.
      3. Confirm `resume/output/ats.pdf` exists, is non-empty, and remains untracked.
    - Expected: Automatic selection uses the first usable engine and reports only a verified
      artifact.
    - Notes:

  - [ ] RC-001.3: PDF extraction and page count
    - Prerequisites: The public ATS PDF plus Poppler or Docker.
    - Steps:
      1. Run `npm run check:local:ats`.
      2. Inspect the report summary without copying resume content into notes.
    - Expected: Page count and extraction name the tool used; missing capability is incomplete
      evidence, not a pass.
    - Notes:

  - [ ] RC-001.4: Alternate launch/platform behavior
    - Prerequisites: A Windows GUI launched with a different environment than the development
      PowerShell session.
    - Steps:
      1. Run `npm run check:tools` from the terminal.
      2. Run the same workflow from the alternate launch context.
      3. Restart the GUI after any `PATH` change and compare results.
    - Expected: Each context reports its actual tools and gives actionable recovery guidance.
    - Notes:
