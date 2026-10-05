# Linux Compatibility

## Support Status

Linux is not a supported product target. The historical Stage 5 plan RC-010.3 is retained in
Project Records; this retired product's plan is not renewed execution authority.

Do not interpret Node-only container results, POSIX path tests, or source-code branches as current
desktop product acceptance.

## Historical Engineering Evidence

On 2026-07-03/04, a disposable Node 22 Linux container ran `npm ci`, formatting, lint, tests, and
tool discovery. Forty tests passed at that time. TeX, Poppler, Docker-in-Docker, browser preview, UI,
packaged CLI, and complete PDF acceptance were not proved.

The tester runner recognizes `.venv/bin/python`. This is portable implementation evidence, not a
support guarantee.

## Stage 5 Entry Command

On a real Linux desktop with Node.js 22+, a reachable Docker engine using Linux containers, and a
Chromium-family browser:

```bash
npm ci
npm run acceptance:platform -- --claim linux
```

The lane covers clean install, package inventory, packaged CLI, public PDF/check/comparison,
loopback preview, real-browser rendering, privacy, and shutdown. It rejects containers used as
desktop evidence, missing browsers, skips, and failures. Record the exact distribution, version,
architecture, display session, Docker runtime, and browser; one tested distribution does not imply
all Linux distributions.

Native TeX and Poppler may be evaluated as optional alternatives. The primary design to prove is
host Node.js plus short-lived TeX/Poppler containers, matching
[`docs/container-boundary.md`](docs/container-boundary.md).

See [`docs/platform-acceptance.md`](docs/platform-acceptance.md) for the parity matrix and the
headless POSIX core slice. Until a current desktop result passes, Linux remains unsupported.
