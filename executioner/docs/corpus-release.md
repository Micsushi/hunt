# C3 v3 local release

This package is a local Tier 2 candidate. It is not deployed and does not
perform final application submission. The MCP surface is limited to
`start_journey`, `cancel_journey`, `journey_status`, and `journey_result`.

## Build and verify

Use Node.js 22.18 or newer.

```text
npm ci
npm run quality
npm run audit
npm run package:verify
npm run package:build
```

`package:build` writes the tarball, CycloneDX SBOM, and SHA-256 checksum under
the ignored repository `.runtime/c3-package` directory. The package allowlist
contains runtime TypeScript source and this release note. It excludes fixtures,
tests, frozen bundles, ledgers, evidence, account data, and local configuration.

Install the tarball into an empty local directory with `npm install <tarball>`.
Runtime account custody and browser policy remain operator-provisioned through
the existing S2 runbook. No account value is part of this package.

## Frozen corpus

```text
npm run corpus:freeze
npm run corpus:accept -- --frozen <bundle-path>
```

A freeze refuses a dirty tree and pins the source revision, tree, lockfile,
manifest, variant map, runtime configuration, and fixture hashes. An existing
bundle is restartable only when every identity still matches. A fix requires a
new clean revision and a new bundle path. Archive the old runtime directory;
do not patch a bundle or ledger.

The checked-in 40-slot corpus is synthetic because the S3-F1/F2/F3 lane
artifacts are unavailable at this integration base. Replace the fake ports
with accepted upstream providers and create a new freeze before any live
corpus claim.

Rollback means stopping the candidate, retaining its sanitized report, and
returning to the accepted C3 backup reference documented by the repository
owner. Publication, deployment, and rollback execution require owner approval.
