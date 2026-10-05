# Stage 5 Owner Manual-Testing Backlog

These Tier 3 checks do not block Tier 2 unless explicitly relabeled `release-blocking`.

## S5-F1 Portable contract

- [ ] Owner reviews the Windows public-fixture workflow
  - State: not tested
  - Prerequisites: Windows 11, Node.js 22+, Docker Desktop, Chromium-family browser.
  - Test:
    1. Run `npm ci`.
    2. Run `npm run acceptance:platform -- --claim windows`.
    3. Open the ignored result named by the command.
  - Expected: the claim passes; every required row passes; the result contains no private path,
    resume/JD content, credential, or raw command output.
  - Notes:

## S5-F2 macOS compatibility

- [ ] Owner reviews the tested macOS workflow
  - State: not tested
  - Prerequisites: real macOS desktop, Node.js 22+, Docker engine, Chromium-family browser.
  - Test:
    1. Run `npm ci`.
    2. Run `npm run acceptance:platform -- --claim macos`.
    3. Open the editor, make a harmless public-fixture edit, save, build, check, and stop preview.
  - Expected: exact tested host is certified; UI remains loopback-only; no child or port remains.
  - Notes:

## S5-F3 Linux compatibility

- [ ] Owner reviews the tested Linux desktop workflow
  - State: not tested
  - Prerequisites: real Linux desktop/display, Node.js 22+, Docker engine, Chromium-family browser.
  - Test:
    1. Run `npm ci`.
    2. Run `npm run acceptance:platform -- --claim linux`.
    3. Open the editor, make a harmless public-fixture edit, save, build, check, and stop preview.
  - Expected: exact tested distribution is certified; UI remains loopback-only; no child or port
    remains.
  - Notes:

## S5-F4 Three-platform parity

- [ ] Owner compares Windows, macOS, and Linux product feel
  - State: not tested
  - Prerequisites: three passing current desktop evidence files.
  - Test: repeat the same public edit/build/check/preview/save-output flow on all three hosts.
  - Expected: observable status, findings, privacy, preview, output, and failure behavior match;
    only documented runtime identities differ.
  - Notes:
