# Resume Cooker

Public sample project for resume PDF generation, local checks, and ATS parsing experiments.

## Layout

- `resume/source/` stores synthetic LaTeX resume examples. Personal resume files must stay outside
  Git and the npm package.
- `resume/output/` is reserved for generated PDFs and extracted text outputs.
- `cli/` owns the packaged `resume-cooker` process boundary.
- `generator/` stores the local LaTeX-to-PDF build and preview workflow.
- `checker/` stores staged local/API/preflight/postflight report code.
- `testers/` stores local snapshots of ATS/resume testing tools.
- `fixtures/` stores sample job descriptions and extracted resume text used by tests.
- `docs/` stores notes about ATS testing methods and repo decisions.

## Human Documentation

- `docs/product-decisions.md`: accepted ATS, page, enforcement, comparison, tester, API, CLI, UI,
  and platform contracts.
- `docs/container-boundary.md`: portable host versus TeX/Poppler container responsibilities.
- `docs/platform-acceptance.md`: Stage 5 public-fixture parity matrix and exact host entry commands.
- `docs/manual-test-stage-1.md`: optional owner checks kept separate from Stage 1 AI acceptance.
- `docs/resume-quality-criteria.md`: criteria list for parseability, ATS safety, evidence quality, keyword coverage, and post-tailoring regressions.
- `docs/hunt-c2-integration-notes.md`: implemented Hunt preflight/postflight boundary and rollback.
- `docs/cli-contract.md`: packaged command, schema, stream, privacy, and exit contract.
- `docs/ui-contract.md`: local editor state, HTTP, file, output, and privacy contract.
- `docs/evaluation-suites.md`: planned separation between local-only checks, optional API checks, and full checks.
- `docs/ats-testing-methods.md`: practical ATS testing approaches.
- `docs/tester-sources.md`: provenance for copied tester snapshots.

## Current State

The repository provides a packaged Windows CLI, deterministic resume checks, Hunt/Fletcher quality
gate, and a secure loopback raw-LaTeX editor without redesigning the LaTeX source model.

Historical implementation checkpoint (not a current execution queue):

1. Stage 1 is implementation complete: capability, build, extraction, preview, and CI gates are
   AI-accepted.
2. Stage 2 is implementation complete: the Windows ATS PDF, text, page, independent parser, and
   current/stale preview workflow are AI-accepted.
3. Stage 3 is implementation complete: isolated tester evidence and deterministic postflight
   regressions are AI-accepted through Tier 2.
4. Stage 4 is implementation complete through Tier 2: the packaged CLI, Hunt process integration,
   and local editing/review UI passed integrated Windows acceptance.
5. Keep external API/model review explicit, bounded, and advisory because resume and JD content may
   be private.
6. Stage 5's portable runtime contract and reproducible Windows/Linux-core evidence are implemented.
   Real macOS and Linux desktop capability lanes remain required before support claims.

Historical plans, package identities and acceptance evidence are retained in Project Records.
This product is retired; missing capabilities route to Hunt without lifting its existing holds.
The human contracts below remain usable without private tracking access. File presence or
historical commit messages do not prove task completion or platform support.

## Requirements

Supported target: Windows 11. The Stage 5 portable contract is implemented; macOS and Linux remain
unsupported until their real desktop lanes and three-platform parity pass.

- **Node.js 22+ and npm**: required for all `npm` scripts, tests, and deterministic checks.
- **Docker Desktop with the WSL 2 backend and Linux containers**: recommended for PDF generation
  and PDF-based checks (`build:pdf`, `check:local:ats`, `check:testers`). Native Windows TeX and
  Poppler tools are optional alternatives. `npm run check:tools` reports which engines are usable;
  non-PDF checks and tests run without TeX tooling.

See [`WINDOWS_COMPATIBILITY.md`](WINDOWS_COMPATIBILITY.md) for setup and
[`docs/container-boundary.md`](docs/container-boundary.md) for the constrained mount/access model.

## Quick Commands

```bash
npm ci
npm run check:tools
npm run format:check
npm run lint
npm test
npm run ci
npm run acceptance:platform -- --claim windows
npm run check:local
npm run check:local:ats
npm run check:local:ats:strict
npm run check:api
npm run check:full
npm run check:testers
npm run check:testers:strict
npm run compare
npm run compare:fixtures
npm run build:pdf
npm run build:pdf:ats
npm run preview
node cli/resume-cooker.mjs --help
node cli/resume-cooker.mjs tools --json
node cli/resume-cooker.mjs preview --resume resume/source/ats.tex --json
```

## Packaged CLI and local editor

The package exposes `resume-cooker tools|build|preview|check|compare|testers`. Paths resolve from the
caller's working directory, JSON mode emits one schema-v1 report, and `--out` atomically persists
the same run. Tester applications are resolved from the caller's `testers/` directory or an
explicit `--tester-root`; they are not bundled. API/full checks require explicit `--allow-api`;
credentials alone do not authorize a request.

To prove the package boundary locally, pack it and install the tarball into a separate workspace:

```powershell
npm pack --pack-destination .runtime\package
cd C:\path\to\resume-workspace
npm install C:\path\to\resume-cooker\.runtime\package\resume-cooker-0.1.0.tgz
npx --no-install resume-cooker --help
npx --no-install resume-cooker preview --resume resume\source\ats.tex --json
```

Preview writes an ephemeral one-use loopback launch URL to stderr. Opening it establishes a strict
local session and redirects to a clean `http://127.0.0.1:<port>/` URL; unauthenticated local
processes cannot read or mutate the source or PDF. The editor supports explicit, revision-checked
save, cancellable builds/checks, current/stale PDF state, local findings, tool readiness, and
verified output under `resume/output`. See
[`docs/cli-contract.md`](docs/cli-contract.md) and [`docs/ui-contract.md`](docs/ui-contract.md).

## Stage 1 Local Foundation

Stage 1 keeps the repo locally usable and CI-checkable before adding ATS scoring, text
extraction, job-description matching, or tester wrappers.

- `npm run preview` starts the local browser preview and builds a temporary PDF under
  `.runtime/preview/`.
- `npm run build:pdf` is the intentional saved-PDF command and writes to `resume/output/`.
- `npm run build:pdf:ats` builds the single-column ATS-safe source at `resume/source/ats.tex`.
- `npm run check:tools` prints available local tools and whether Docker is usable. It is a probe,
  so missing TeX tools do not fail the command unless you pass `-- --require-pdf-engine`.
- `npm run format`, `npm run format:check`, `npm run lint`, and `npm test` cover root-owned
  project files and generator code.
- `npm run ci` runs the lightweight root checks used by GitHub Actions.
- Vendored tester snapshots under `testers/` are excluded from root formatting/linting, while CI
  audits their locked dependencies and runs the hardened ATS-Checker helper tests.

Generated files stay out of Git: saved PDFs belong under `resume/output/`, and preview artifacts
belong under `.runtime/preview/`.

## Staged Checks

The staged commands produce stable reports under `.runtime/reports/` by default:

- `npm run check:local` runs deterministic local preflight checks against the current source and
  sample JD.
- `npm run check:local:ats` builds and checks the ATS-safe variant, including the one-page hard
  gate when a PDF is produced.
- `npm run check:api` runs only when API review is explicitly enabled; otherwise it reports that
  content stayed local.
- `npm run check:full` combines local and API reports.
- `npm run check:testers` explicitly attempts tester integrations and writes normalized skip/pass
  results from isolated tester environments. Missing tools report warnings instead of running in
  CI; global Python or `tsx` installations never count as execution evidence.
- `npm run check:testers:strict` runs the same adapters while requiring ATS-Checker.
- `npm run compare` runs postflight regression checks against a before/after resume pair.
- `npm run compare:fixtures` executes the full synthetic Stage 3 status/exit matrix against the
  built public ATS PDF.

Reports are written under `.runtime/reports/` by default and stay private/ignored. The stable status
values are `pass`, `pass_with_warnings`, and `fail`.

API review requires both the API suite and explicit environment configuration. Supported providers:

```bash
RESUME_COOKER_ALLOW_API=true OPENROUTER_API_KEY=... npm run check:api
RESUME_COOKER_ALLOW_API=true RESUME_COOKER_API_PROVIDER=anthropic ANTHROPIC_API_KEY=... npm run check:api
```

Optional API settings:

- `RESUME_COOKER_API_PROVIDER`: defaults to `openrouter` when API review is explicitly enabled.
- `RESUME_COOKER_API_MODEL`: provider model name.
- `RESUME_COOKER_API_TIMEOUT_MS`: request timeout in milliseconds.
- `RESUME_COOKER_API_MAX_INPUT_CHARS`: privacy/cost guardrail; defaults to `24000`.
- `RESUME_COOKER_API_MAX_TOKENS`: provider output cap; defaults to `1024`.
- `OPENROUTER_SITE_URL` and `OPENROUTER_SITE_NAME`: optional OpenRouter app attribution headers.

## Remaining Work

Stage 5/RC-010.1 owns the implemented portable contract and acceptance runner. RC-010.2 and
RC-010.3 still require real macOS and Linux desktop hosts; RC-010.4 then compares their results and
publishes exact support. Optional owner checks are tracked separately in
[`docs/manual-test-stage-5.md`](docs/manual-test-stage-5.md). Use
Project Records for the retained historical package registry; this is not an instruction to
resume retired work or perform platform/provider qualification.
