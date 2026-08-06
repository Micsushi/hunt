# C3 v3 local release

This is a local Tier 2 candidate. It is not deployed and never performs final
application Submit. The package exports only the MCP module with
`start_journey`, `cancel_journey`, `journey_status`, and `journey_result`.

## Build and verify

Use Node.js 22.18 or newer:

```text
npm ci
npm run corpus:impact:validate
npm run corpus:page-ui:accept
npm run corpus:freeze
npm run corpus:accept -- --frozen <bundle-path>
npm run audit
npm run quality
npm run package:verify
npm run package:build
```

`corpus:freeze` requires a clean committed revision. It pins the source
revision/tree, package lock, accepted manifest, fixture manifest and files,
variant map and declarations, source reconciliation, acceptance configuration,
the retained historical `source.snapshot`, and exact impact SHA. The snapshot
comes from ancestor `16c48bd1470addc9d9480d785ae84e412edd55ef`; it is deliberately
independent of the current public catalog. Drift, F3 activation/evidence, dormant semantic artifacts,
or a changed prerequisite blocks the freeze.

`corpus:accept` executes the four accepted fixtures and creates a sealed offline
40-slot reconciliation. A restart validates the prior ledger but reruns all
fixtures. Retry is bounded by the frozen configuration. Fixes require a new
clean commit and bundle path. Never patch a bundle, ledger, or report.

The report can only be `accepted_fixture` or `rejected`. It never claims live
corpus or live Review certification. The owned Stage 2 Playwright
application/recovery/Review adapter is implemented and locally verified, but a
real Workday proof still requires approved current owner config, immutable
profile and resume sources, a valid account and session, and a protected
evidence destination.

`package:build` writes a tarball, CycloneDX SBOM, and SHA-256 checksum under the
ignored repository `.runtime/c3-package` directory. The allowlist contains
generated `package.json` and `README.md`, compiled JavaScript, declarations, and
these release notes. It excludes
fixtures, tests, frozen bundles, ledgers, evidence, account data, and local
configuration.

Install the tarball into an empty directory with `npm install <tarball>`.
Import `@hunt/executioner/mcp` and confirm the exact four methods above.
`package:verify` performs two reproducibility builds, content scans, a clean
temporary install, and that MCP probe.

Rollback means stopping the candidate, retaining only sanitized reports, and
returning to the owner-approved backup reference. Publication, deployment, and
rollback execution require owner approval.
