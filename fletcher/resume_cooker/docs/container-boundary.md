# Host And Container Boundary

Resume Cooker is a host-side Node.js application. Containers are narrow adapters for heavyweight
PDF tools, not the application runtime. This boundary is identical on supported Windows, macOS, and
Linux hosts.

## Responsibility Matrix

| Concern                          | Owner                                     | Access                                       |
| -------------------------------- | ----------------------------------------- | -------------------------------------------- |
| CLI orchestration and validation | Host Node.js 22+                          | Workspace paths selected by the user         |
| LaTeX compilation                | TeX container or optional native tool     | Read-only source directory plus `/output`    |
| PDF text and page inspection     | Poppler container or optional native tool | Exact PDF file plus narrow `/output` staging |
| Temporary build output           | Tool adapter                              | Ignored `.runtime/` staging paths            |
| Intentional saved PDF            | Host                                      | Verified atomic write under `resume/output/` |
| Reports                          | Host                                      | Ignored `.runtime/reports/`                  |
| Preview server and browser       | Host                                      | Loopback `127.0.0.1` only                    |

The container workflow does not mount the user home directory, credential stores, Docker socket,
browser state, unrelated drives, or network shares. It does not expose an application port.
Container source, staging, and output paths must resolve inside the selected workspace before
Docker starts. Container-relative paths always use forward slashes. TeX and Poppler images are
referenced by immutable multi-platform registry digests. Every document-tool container disables
networking, uses a read-only root filesystem, drops all Linux capabilities, sets
`no-new-privileges`, runs as the host-equivalent non-root numeric user, and has bounded CPU, memory,
PID, and temporary-filesystem resources. The host copies verified artifacts from the one writable
staging mount.

## Why The Whole App Is Not Containerized

A full application container would make host paths, file watching, browser launch, preview ports,
ownership, and editor access more complex without improving the PDF boundary. Node already runs on
the host; only TeX and Poppler benefit materially from isolation.

Docker Compose is intentionally absent. Each tool invocation is short-lived and created by the
existing command adapter. The host Docker CLI talks to its normal local engine; Resume Cooker never
uses Docker-in-Docker or mounts the Docker socket.

## Lifecycle

Every external command has a finite timeout and a combined output-byte ceiling. Host cancellation,
timeout, or output overflow terminates the spawned command and its descendants and waits for that
termination. Windows uses the native process-tree termination path. POSIX hosts place each command
in its own process group and signal that group, then escalate to `SIGKILL` after a bounded grace
period if any member ignores `SIGTERM`. Preview shutdown cancels active work, closes the loopback
server, and preserves only intentional saved output.

## Privacy And Network

The first use of a pinned image may download it from its registry. The document-tool container
itself always runs with `--network=none`; after the image exists locally, PDF build and inspection
operate only against bind-mounted local files. Resume and job-description contents are not uploaded
by this workflow. Optional API review has a separate explicit consent boundary.

## Verification

Run the shared public-fixture lane from the repository root:

```bash
npm ci
npm run acceptance:platform -- --claim windows
npm run acceptance:platform -- --claim macos
npm run acceptance:platform -- --claim linux
```

Run only the claim matching the current real desktop host. The runner rejects OS mismatches,
containers used as desktop evidence, missing browser evidence, skips, and failed required rows.
Exact commands and evidence classes are defined in
[`docs/platform-acceptance.md`](platform-acceptance.md).
