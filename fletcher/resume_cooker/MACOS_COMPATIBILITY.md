# macOS Compatibility

## Support Status

macOS is not a supported product target. The historical Stage 5 plan RC-010.2 is retained in
Project Records; this retired product's plan is not renewed execution authority.

Do not interpret POSIX path tests, source-code branches, or the historical audit below as current
product acceptance.

## Historical Engineering Evidence

On 2026-07-04, native macOS root Node checks passed and the repository was statically reviewed for
native TeX/Poppler and Docker paths. That audit predated the current package/stage acceptance model
and did not prove the complete PDF, parser, preview, UI, lifecycle, or packaged CLI workflow.

The tester runner recognizes the POSIX virtual-environment interpreter `.venv/bin/python`. This is
portable implementation evidence, not a support guarantee.

## Stage 5 Entry Command

On a real macOS desktop with Node.js 22+, a reachable Docker engine using Linux containers, and a
Chromium-family browser:

```bash
npm ci
npm run acceptance:platform -- --claim macos
```

The lane covers clean install, package inventory, packaged CLI, public PDF/check/comparison,
loopback preview, real-browser rendering, privacy, and shutdown. It rejects non-macOS hosts,
containers used as desktop evidence, missing browsers, skips, and failures. Record Apple Silicon or
Intel identity exactly; neither implies the other.

MacTeX/BasicTeX and native Poppler may be evaluated as optional alternatives. The primary design to
prove is host Node.js plus short-lived TeX/Poppler containers, matching
[`docs/container-boundary.md`](docs/container-boundary.md).

See [`docs/platform-acceptance.md`](docs/platform-acceptance.md) for the parity matrix. Until a
current result passes, macOS remains unsupported.
