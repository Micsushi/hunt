# S3-F4 acceptance summary

The local acceptance implementation covers immutable freeze identities,
fixture-first sequential reconciliation, bounded retry and restart, sealed
browser-truth comparison, privacy and issue gates, and an allowlisted local
package with SBOM and checksum.

The checked-in 40-slot manifest and adapters are synthetic substitutes for the
unavailable S3-F1/F2/F3 lane artifacts. A successful local report is therefore
`accepted_fixture` with `liveCorpusCertified: false`. No real 40-job corpus,
account, mailbox, Workday browser, or final Submit action is certified by this
result.

Live-corpus acceptance remains blocked until accepted upstream providers and
the frozen prior-corpus manifest are integrated. That integration must create a
new clean revision and freeze. It may not relabel or reuse synthetic evidence.

Tier 3 publication and Tier 4 owner testing remain separate, owner-controlled
steps. See `corpus-release.md` and `owner-test-backlog.md`.
