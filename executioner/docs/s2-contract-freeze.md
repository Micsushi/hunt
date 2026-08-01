# C3 Stage 2 F0 contract freeze

Status: frozen

The accepted Stage 1 base is
`87c77e538d8bba378ec93516dbea3f4747beb822`. The machine-readable Stage 2
contract source is
`7bb1722fca3ab8807965ee39a212ad2c01f2cf87`. The machine-readable Stage 2
record is `docs/s2-contract-revision.json`. It freezes the Git tree object IDs
for the complete contract surface, live contract subset, F9 live coordinator,
deterministic live test kit, live contract tests, and offline walking
skeletons without changing the historical Stage 1 freeze record.

## Frozen versions

The common Stage 2 terminal result and MCP response use version 4. Error and
event envelopes use version 3. The MCP request remains version 2, and durable
journey state remains version 3.

The live target, browser session, secret metadata, mailbox result,
verification artifact, checkpoint, and evidence schemas use version 1. Each
classification layer, sanitized structural observation, unknown candidate,
and reviewed promotion record also uses version 1.

The only admitted target adapters are
`windows-dpapi-current-user-v1` and `gmail-api-v1`. This records allowed
adapter identities, not live permission or secret material.

## Change protocol

S2-F1 and S2-F2 adapter work must start from the accepted F0 tip recorded by
the coordinator. A provider mismatch pauses the affected lane and reopens F0.
The F0 owner then adds a failing contract regression, makes the smallest
compatible repair, updates a serialized version when compatibility breaks,
records new tree object IDs in a replacement Stage 2 manifest, and reruns the
full F0 acceptance gate. Later lanes must not edit the frozen roots locally.

The manifest contains no live URL, account, mailbox, secret, profile, target
token, or provider payload. It does not authorize provider access, deployment,
publication, or final application submission.
