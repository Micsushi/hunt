# Windows Compatibility

## Supported Target

Windows 11 is the supported product environment through Stages 1-4. Use Node.js 22+ on the host.
For PDF generation and inspection, Docker Desktop with the WSL 2 backend and Linux containers is
the recommended runtime.

Resume Cooker keeps orchestration, reports, saved output, preview, and browser access on Windows.
Short-lived containers provide TeX and Poppler. See
[`docs/container-boundary.md`](docs/container-boundary.md).

## Setup

1. Install Node.js 22+ and npm.
2. Install Docker Desktop, select the WSL 2 backend, and use Linux containers.
3. Start Docker Desktop before PDF commands.
4. From PowerShell in the repository, run:

```powershell
npm ci
npm run check:tools
npm run check:tools -- --require-pdf-engine
npm run ci
node cli\resume-cooker.mjs tools --json
```

The Stage 5 shared Windows lane is:

```powershell
npm run acceptance:platform -- --claim windows
```

It uses only public fixtures, installs the package into an ignored caller workspace, exercises
Docker PDF/check/comparison, verifies loopback preview in a real Chromium-family browser, and
confirms shutdown. Evidence stays under `.runtime/platform-acceptance/`.

Current public-fixture evidence (2026-07-26) passed on Windows 11 build 26100, x64, Node.js 25.6.1,
npm 11.9.0, Docker Engine 29.4.0, and Chrome 150.0.7871.182. The package installed from a fresh
tarball, produced a 95,057-byte public PDF, rendered the loopback UI in the real browser, and closed
the server/process tree. Its 59-entry normalized package inventory is
`d86e034abf7935119309be689cf1d8997739c73feb3bb126bf011657c1e0a76d`. This evidence preserves the
documented Node.js 22+ minimum; it does not imply untested Windows, browser, or Docker versions.

The first PDF command may download the TeX or Poppler image. Native Windows `latexmk`,
`pdflatex`, `pdftotext`, and `pdfinfo` are optional alternatives when they are already available.

## PDF Smoke

```powershell
npm run build:pdf:ats
npm run check:local:ats:strict
npm run check:testers:strict
npm run preview -- --source resume/source/ats.tex
node cli\resume-cooker.mjs preview --resume resume\source\ats.tex --json
```

The supported container path must be able to read the selected source from the repository mount and
write ignored staging output. The host verifies the generated file before saving it. Preview binds
to `127.0.0.1`; stop it with `Ctrl+C`. Temporary preview output stays under `.runtime/preview`;
intentional output stays under `resume/output`.

The packaged CLI keeps build staging and Docker mounts in the caller's workspace, not in the npm
installation directory. A fresh tarball install can be checked with:

```powershell
npm pack --pack-destination .runtime\package
mkdir .runtime\fresh-package
cd .runtime\fresh-package
npm init -y
npm install ..\package\resume-cooker-0.1.0.tgz
npx --no-install resume-cooker --version
```

`preview` starts the loopback editor. Mutations require the in-memory CSRF token, source files must
remain under `resume/source`, preview output remains temporary, and an intentional PDF save requires
a safe filename plus explicit overwrite confirmation.

## ATS-Checker Environment

Strict Stage 2 validation requires the vendored ATS-Checker parser. Keep its environment isolated
and ignored:

```powershell
python -m venv testers\ATS-Checker\.venv
testers\ATS-Checker\.venv\Scripts\python.exe -m pip install -r testers\ATS-Checker\requirements.txt
npm run check:testers:strict
```

Resume Cooker prefers that interpreter, executes the vendored `ats.py` parser with a 30-second
timeout, and records only parser identity, counts, and agreement ratio. Extracted text, contact
values, full stderr, and environment paths do not enter the stable report. Normal local checks keep
tester dependencies optional; strict validation exits `69` when ATS-Checker cannot run.

## Troubleshooting

- If Docker is installed but unavailable, start Docker Desktop and rerun `npm run check:tools`.
- If a Docker mount is denied, confirm this repository drive is available to Docker Desktop.
- If a terminal sees a native tool but a GUI-launched process does not, restart the GUI after PATH
  changes and compare its environment with PowerShell.
- If strict tester validation exits `69`, create the isolated ATS-Checker environment above and
  rerun the command.
- If image download fails, restore registry/network access and rerun the command.
- Do not run Docker-in-Docker or mount the Docker socket; Resume Cooker calls the host Docker CLI.
- If a package build cannot see a source, run the command from the workspace containing
  `resume/source`; only that workspace is mounted into the container.

## Cross-Platform Scope

Windows 11 remains the supported product environment while Stage 5 capability lanes are open.
macOS and Linux become supported only after their current real desktop results and three-platform
parity pass. Dated audits and headless/container results are engineering evidence, not support
claims.
