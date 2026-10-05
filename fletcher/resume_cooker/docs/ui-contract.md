# Local UI v1 Contract

The UI is a host-side, loopback-only raw-LaTeX editor. Configured workspace roots and the source
filesystem remain authoritative. It does not own structured resume data, rewrite claims, autosave,
or enable provider calls.

## State

- Source: loading, saved, dirty, conflict, or error. A SHA-256 revision token protects explicit
  saves from external modification.
- Build: idle, running, current, stale, failed, or cancelled. Each operation has an ID and exact
  source revision. A last-good PDF remains viewable but is labeled stale after later failure.
- Check: idle, running, complete, failed, or cancelled. Backend schema/status is authoritative;
  skipped or incomplete evidence never becomes pass.
- Output: idle, saving, saved, conflict, or failed. Saved output requires an approved `.pdf`
  filename and explicit overwrite confirmation.

## HTTP boundary

| Method/path                | Purpose                                                        |
| -------------------------- | -------------------------------------------------------------- |
| `GET /api/bootstrap`       | CSRF token and non-sensitive local configuration               |
| `GET /api/source`          | approved source text, name, metadata, and revision             |
| `PUT /api/source`          | explicit revision-checked atomic save                          |
| `GET /api/status`          | build/current/last-good/stale state                            |
| `POST /api/compile`        | start a build for the current source revision                  |
| `POST /api/compile/cancel` | cancel or supersede the active build                           |
| `POST /api/session/launch` | issue another one-use launch path for an authenticated browser |
| `GET /api/check`           | current report operation state                                 |
| `GET /api/tools`           | truthful local capability readiness and recovery reason        |
| `POST /api/check`          | run local versioned checks                                     |
| `POST /api/check/cancel`   | cancel the current report operation                            |
| `POST /api/output`         | intentionally save and verify a PDF                            |
| `GET /preview.pdf`         | current or clearly stale temporary PDF                         |

Every route requires the opaque session cookie established by a one-use launch capability. Every
mutating endpoint additionally requires the in-memory `x-resume-cooker-csrf` token and a same-origin
request when an Origin header is present. The launch capability is emitted only as explicit
ephemeral startup output, never in the schema-v1 report or persisted report file. Bodies are
bounded. Browser responses contain no provider key, arbitrary absolute path, raw process error, or
unsafe HTML.

## File and privacy policy

Source real paths must remain under configured roots, use `.tex`, and already exist. Traversal,
escaping symlinks, unsupported extensions, stale revisions, and oversized content reject without
mutation. Output is restricted to `resume/output`, requires a safe filename, and never silently
overwrites. Preview stays under `.runtime/preview`.

API review is disabled in UI v1. A future provider flow requires a separate one-use confirmation,
server-side credentials, and RC-005 authorization. The browser never stores resume content or keys
in persistent storage.
