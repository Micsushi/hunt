# Platform Acceptance

Stage 5 preserves the Stage 4 CLI/report/UI boundary while collecting equivalent public-fixture
evidence on each host. Generated results stay ignored under `.runtime/platform-acceptance/`.

## Evidence Classes

| Class                   | Purpose                                                   |
| ----------------------- | --------------------------------------------------------- |
| `T2-core`               | Portable implementation and deterministic regression      |
| `T2-capability:windows` | Exact tested Windows desktop lane                         |
| `T2-capability:macos`   | Exact tested real macOS desktop lane                      |
| `T2-capability:linux`   | Exact tested real Linux desktop lane                      |
| `release-gate`          | Distribution/hosted-CI evidence after platform acceptance |

Headless/container Linux results may prove POSIX code and package portability. They never certify a
Linux desktop or replace a real browser/display lane.

## Parity Matrix

| Row               | Command/observation                                 | Required result                                   |
| ----------------- | --------------------------------------------------- | ------------------------------------------------- |
| Host identity     | acceptance preflight                                | exact OS/arch/Node/npm/Docker/desktop; no paths   |
| Root checks       | `npm run ci`                                        | format, lint, tests, truthful tool probe pass     |
| Production audit  | `npm audit --omit=dev --audit-level=high`           | no high/critical production vulnerability         |
| Package inventory | `npm pack --dry-run --json`                         | required public files; exact normalized SHA-256   |
| Fresh binary      | fresh install; `npx --no-install ... --version`     | binary runs from caller workspace                 |
| Tools             | packaged `tools --json`                             | schema-v1; missing optional tools truthful        |
| Public PDF/check  | packaged Docker build plus local check              | verified PDF; pass/warnings; content stayed local |
| Public comparison | packaged same-source public comparison              | pass/warnings with D7/schema-v1 semantics         |
| Preview HTTP      | launch exchange, `/`, `/api/status`, `/preview.pdf` | authenticated loopback session; public PDF works  |
| Browser UI        | Chromium-family browser `--dump-dom` smoke          | real browser renders Resume Cooker UI             |
| Lifecycle         | cancel preview; retry loopback URL                  | process tree and port are gone                    |
| Artifacts/privacy | evidence and `git status --short`                   | ignored generated files; no content left machine  |

Allowed differences are host paths, process-tree implementation, container provider, browser
identity, and optional native PDF tools. They cannot change command grammar, schema version, status,
D7 exit, stream, privacy, mount, loopback, preview/output, or skip/failure behavior.

## Desktop Entry Commands

Use Node.js 22+, npm, a reachable Docker engine running Linux containers, and a Chromium-family
browser. The browser is auto-detected from common locations; otherwise pass its executable path.

Windows PowerShell:

```powershell
npm ci
npm run acceptance:platform -- --claim windows
```

macOS:

```bash
npm ci
npm run acceptance:platform -- --claim macos
```

Linux desktop:

```bash
npm ci
npm run acceptance:platform -- --claim linux
```

Explicit browser path:

```bash
npm run acceptance:platform -- --claim macos --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
npm run acceptance:platform -- --claim linux --browser /usr/bin/chromium
```

The acceptance result prints only status, claim, and ignored evidence filename. The JSON file
contains bounded identities, the normalized package-inventory SHA-256, and row results, never
commands' raw stdout/stderr. A custom `--output` is accepted only beneath the selected workspace's
ignored `.runtime/platform-acceptance/` directory.

## Headless POSIX Core Slice

This command proves Node 22 formatting, lint, unit/integration, package inventory, portable paths,
and process-tree fixtures on Linux. It intentionally has no Docker socket, browser, or desktop claim:

```bash
docker run --rm --init \
  --mount "type=bind,source=$PWD,target=/workdir" \
  --tmpfs "/workdir/node_modules:exec" \
  --workdir /workdir \
  node:22-bookworm \
  bash -lc "npm ci --ignore-scripts && npm run ci && npm pack --dry-run"
```

Do not pass `--claim linux` in a container. The acceptance runner detects the container and rejects
that claim.

## Support Claim Gate

Do not update a compatibility page from planned to supported until its real desktop result passes
every required row and records exact OS, architecture, Node/npm, Docker, browser, and local
desktop/display-session evidence. Node below 22, missing runtime identities, remote/headless Linux,
containers, and malformed schema/privacy reports cannot certify a desktop. Do not infer support for
another distribution, architecture, browser, container runtime, or native PDF tool.
