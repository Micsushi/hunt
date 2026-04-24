# Hunter -> Coordinator Research Notes

This document records the external research used to shape C4 planning.

Research date:
- 2026-04-12

Goal:
- capture a few high-signal constraints that materially affect Hunter -> Coordinator design
- link directly to the primary docs worth re-reading later

## Executive Summary

Research points to a narrow, low-risk first shape:
- keep auth state and browser artifacts outside repo checkout
- treat attached-session browser work as a separate lane
- use persistent-context Chromium for extension-focused automation work
- keep SQLite on one host with one active execution writer
- rely on durable run/event/artifact records instead of prompt-only orchestration state

## Findings

### 1. Playwright auth state is filesystem-based and sensitive

Official source:
- https://playwright.dev/docs/auth

Important details:
- Playwright recommends saving authenticated browser state to disk and reusing it across runs
- Playwright explicitly warns that the browser state file may contain sensitive cookies and headers and should not be committed

Implication for Hunt:
- C4/C3 auth state belongs under the runtime root, not in repo
- auth state needs tighter permissions than ordinary logs

### 2. `storageState` does not cover session storage

Official source:
- https://playwright.dev/docs/auth

Important details:
- Playwright documents that session storage is domain-specific and is not persisted across page loads
- Playwright does not provide a built-in API to persist session storage

Implication for Hunt:
- some sites may not be reproducible from cookie/local-storage state alone
- this is one reason to preserve a signed-in operator lane instead of assuming all auth can be replayed from saved state

### 3. Chrome extension automation requires persistent Chromium context

Official source:
- https://playwright.dev/docs/chrome-extensions

Important details:
- extensions only work in Chromium with a persistent context
- Google Chrome and Microsoft Edge removed the flags needed to side-load extensions
- Playwright recommends bundled `chromium`
- Manifest V3 service workers suspend after about 30 seconds of inactivity and restart on demand

Implication for Hunt:
- extension-oriented C3 automation harness should use persistent-context Chromium
- do not plan around side-loading C3 into stock Chrome or Edge on Linux
- bridge code should expect MV3 service-worker sleep/restart behavior

### 4. Traces are high-value debugging artifacts

Official source:
- https://playwright.dev/docs/trace-viewer

Important details:
- Playwright Trace Viewer captures action history, DOM snapshots, screenshots, console, network, metadata, and attachments
- traces can be opened locally or in `trace.playwright.dev`
- trace viewer loads local traces in-browser without transmitting data externally

Implication for Hunt:
- failed or blocked C4/C3 runs should save traces by default when practical
- trace capture is better than relying on screenshots alone for flaky ATS behavior

### 5. OpenClaw already matches C4 orchestration needs

Official sources:
- https://docs.openclaw.ai/automation
- https://docs.openclaw.ai/tools/browser

Important details:
- OpenClaw has background task records and a higher-level Task Flow surface for durable multi-step orchestration
- the managed `openclaw` browser profile is isolated from personal browsing
- the built-in `user` profile attaches to an existing signed-in browser session

Implication for Hunt:
- OpenClaw is a reasonable C4 runtime candidate because it already provides:
  - durable task records
  - explicit browser profiles
  - audit-friendly orchestration surfaces
- the lane split in Hunt should mirror OpenClaw's isolated vs attached browser modes

### 6. OpenClaw existing-session mode is explicitly higher-risk and more limited

Official source:
- https://docs.openclaw.ai/tools/browser

Important details:
- existing-session mode attaches to a live signed-in browser and is higher risk than the isolated managed profile
- some actions remain more limited than the managed browser path
- upload hooks in existing-session mode require refs and support one file at a time

Implication for Hunt:
- existing-session lane should be explicit and operator-approved
- use managed browser path whenever possible
- do not assume feature parity between managed and attached lanes

### 7. OpenClaw extension relay can control existing Chrome tabs

Official source:
- https://docs.openclaw.ai/tools/chrome-extension

Important details:
- OpenClaw's Chrome extension can control existing Chrome tabs through a relay and profile surface
- it is meant for controlling normal Chrome tabs instead of an OpenClaw-managed profile

Implication for Hunt:
- if C4 eventually needs operator-browser continuity, there is a documented extension-relay path
- this should still be treated as a deliberate lane, not the default path

### 8. Linux browser packaging matters for OpenClaw

Official source:
- https://docs.openclaw.ai/tools/browser-linux-troubleshooting

Important details:
- OpenClaw documents snap Chromium as a common failure source on Ubuntu because AppArmor confinement interferes with browser launch/monitoring
- recommended fix is Google Chrome `.deb`, or attach-only mode if snap Chromium must be used

Implication for Hunt:
- production `server2` docs should not casually say "install Chromium"
- browser package choice is part of deployment reliability

### 9. SQLite WAL improves concurrency, but still only one writer exists at a time

Official source:
- https://sqlite.org/wal.html

Important details:
- WAL lets readers and writers proceed concurrently
- all processes must be on the same host; WAL does not work over network filesystems
- only one writer can exist at a time
- long-running readers can starve checkpoints and let WAL grow

Implication for Hunt:
- keep Hunt DB local to `server2`
- keep C4 single-run execution guardrails
- avoid long read transactions in review surfaces

### 10. SQLite busy timeout and WAL checkpoint settings are relevant knobs

Official sources:
- https://sqlite.org/pragma.html#pragma_busy_timeout
- https://sqlite.org/pragma.html#pragma_busy_timeout

Important details:
- `PRAGMA busy_timeout` is the SQLite-level busy-handler configuration
- `wal_autocheckpoint` defaults to 1000 pages
- passive checkpoints do not wait on readers

Implication for Hunt:
- current 30-second busy timeout in `coordinator/db.py` is sensible
- if run volume grows, checkpoint behavior and stale readers become part of ops tuning

## Recommended Planning Decisions From This Research

### Decision 1

Keep runtime state outside repo checkout.

Reason:
- auth state, traces, screenshots, and resume payloads are sensitive and operational

### Decision 2

Model two browser lanes from day one.

Reason:
- official tooling clearly distinguishes isolated managed browsing from attached signed-in browsing

### Decision 3

Keep one active execution run at a time for first production phase.

Reason:
- SQLite single-writer limits
- browser debugging complexity
- shared auth dependency risks

### Decision 4

Make run artifacts first-class operator evidence.

Reason:
- trace/snapshot/browser-summary artifacts are more dependable than prompt memory when diagnosing ATS breakage

## Primary Sources

- Playwright Authentication: https://playwright.dev/docs/auth
- Playwright Chrome Extensions: https://playwright.dev/docs/chrome-extensions
- Playwright Trace Viewer: https://playwright.dev/docs/trace-viewer
- SQLite WAL: https://sqlite.org/wal.html
- SQLite PRAGMA reference: https://sqlite.org/pragma.html#pragma_busy_timeout
- OpenClaw Automation & Tasks: https://docs.openclaw.ai/automation
- OpenClaw Browser: https://docs.openclaw.ai/tools/browser
- OpenClaw Chrome Extension: https://docs.openclaw.ai/tools/chrome-extension
- OpenClaw Linux Browser Troubleshooting: https://docs.openclaw.ai/tools/browser-linux-troubleshooting
