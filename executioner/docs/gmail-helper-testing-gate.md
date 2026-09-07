# Gmail helper testing and Defender gate

## Current boundary

The full native Gmail helper gate is **not cleared**. Do not run the full
`interactive-gmail-oauth-sealer.test.ts` file or the complete test suite on this
host until the retained detection is adjudicated. Do not disable protection,
add exclusions, restore quarantine, change command spelling to avoid detection,
or count a skipped native test as a pass. Live C3 admission remains blocked.

The retired lookup unit test compiled the complete embedded OAuth helper using
PowerShell `Add-Type`, then used reflection to invoke `LookupTarget` and
`ValidRecipientBindingId`. Its intended assertions only needed pure hashing and
validation. Loading the complete helper unnecessarily included native credential
read/write/delete, DPAPI, OAuth HTTP, and loopback-listener capabilities.

Static inspection of the invoked lookup methods and their dependencies found
string checks, UTF-8 framing, SHA-256, hex formatting, and array clearing. It did
not find credential or network calls in that slice. The broader helper contains
those capabilities for the OAuth workflow, with target-prefix validation and
fixed provider endpoints in the inspected paths. This is not a whole-helper
security certification or a finding that Defender was wrong. The recorded alert
identifies a command line, not a confirmed malicious instruction or byte offset.

## Safe replacement coverage

`tests/secrets/gmail-lookup-policy.test.ts` reads, but never imports or executes,
the privileged helper. It extracts four exact pure production methods, the scope
constant, and the simple typed exception. A reviewed SHA-256 digest pins this
slice before compilation. Source drift fails before execution and requires a
new side-effect review, not an automatic digest update.

The standalone fixture uses the Windows C# compiler directly, no PowerShell,
reflection, native imports, credential store, DPAPI, network, accounts, or private
input. It prints synthetic lookup digests only. Compiler and fixture invocations
have a 15-second timeout and 64 KiB output cap. Temporary files are removed.
Coverage retains the original digest and opaque-output assertions and adds
recipient length/alphabet/null cases, invalid client cases, and binding changes.
It does not stand in for native credential persistence or OAuth integration.

Run only this affected fixture with the pinned Node runtime:

```text
node --test tests/secrets/gmail-lookup-policy.test.ts
```

Non-Windows runs explicitly skip native C# execution; source-slice validation
still runs. Production helper bytes and its integrity launcher are unchanged.

## Evidence and release action

Investigation baseline: `1f2ee6f8`. Read-only host evidence showed seven matching
`Trojan:Win32/Commando.A!ml` detections, threat ID `2147840094`. Recorded actions
were successful; current threat fields were `IsActive=false` and
`DidThreatExecute=false`. These fields are not proof of a false positive.
Protection remained enabled after the harmless fixture runs.

The private reservation records exact source, embedded C#, command-resource and
reviewed-slice hashes plus host versions. Preserve the original detection record;
the command was removed from the unit suite, not retested with altered flags.

Required next action: authorized security owner reviews the retained command
resource, exact source hashes and expected capabilities with Microsoft or the
organization's security process. Microsoft supports file/hash submissions for
analysis in its [submission guide](https://learn.microsoft.com/en-us/unified-secops/submission-guide).
The observed resource is command-line based, so obtain the supported diagnostic
submission route if source/hash evidence alone cannot reproduce the detection.
Do not upload private credentials, resumes, profiles, or broad diagnostics without
separate approval. No submission was made during this investigation.

After an affirmative adjudication or a separately reviewed replacement of the
remaining native boundary, run the required full native/offline gates with
protection enabled on the exact candidate. Only then may readiness and the frozen
fresh C3 campaign resume. The pure fixture passing does not authorize live runs.
