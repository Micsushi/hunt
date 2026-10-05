# Stage 4 Optional Owner Checks

Stage 4 implementation and Tier 2 agent verification do not depend on these checks. They are the
separate Tier 3 owner backlog for subjective or deployment-specific confirmation.

- Run the packaged UI with a private resume only after confirming the local workspace and ignored
  output/report paths meet the owner's privacy expectations.
- Try the editor with the owner's preferred browser, Windows scaling, high-contrast mode, keyboard,
  and screen reader; record any usability preference that objective browser acceptance did not
  capture.
- Enable the disabled-by-default Hunt gate in the intended service environment, confirm the
  installed CLI command and report retention policy, then rehearse rollback by removing
  `HUNT_RESUME_COOKER_ENABLED`.
- Review an intentional preflight or postflight override with the responsible human actor and
  confirm the reason/timestamp evidence is sufficient for the operating process.
- Decide whether and where the `resume-cooker` package will be published. A registry release,
  deployed Hunt enablement, and native Windows installer are release decisions, not Stage 4 Tier 2
  prerequisites.

## Preview freshness recovery

With a synthetic source, build a preview, then edit the source in another editor.
The visible page checks status every two seconds (only while visible, one request
at a time) and when focused. It must label the retained PDF stale without changing
unsaved text in the browser. Reload the source explicitly to resolve a save
conflict, then rebuild to produce a current PDF. A missing source keeps the last
good PDF visibly stale; a missing PDF becomes unavailable. A disconnected status
request must not leave a current claim visible.

Freshness compares the current source content revision with the last successful
artifact's source revision on status and preview reads. It is an observation at
request time, not a filesystem watcher or a lock against arbitrary external
editors. Service-owned saves, publication, and freshness transitions share one
queue; older builds cannot publish after a newer save/build. `getStatus()` is
asynchronous, including for programmatic callers. No private source is needed to
verify this behavior:

```powershell
node --test generator/scripts/preview-server.test.mjs generator/scripts/ui-services.test.mjs cli/resume-cooker.test.mjs
```

The optional headless browser regression uses an already installed Playwright
module, supplied as a file URL via `RESUME_COOKER_PLAYWRIGHT_MODULE`, then runs
`node --test generator/scripts/preview-browser.test.mjs`. Without that module it
reports skipped, not passed. Its server uses an ephemeral loopback port, synthetic
temporary source/PDF fixtures, and closes its own browser and server afterward.
