# Stage 1 Local Verification

## Status

Stage 1 has local Tier 2 evidence for all thirteen stable feature IDs and the
integrated controlled journey. This evidence is not Tier 3: it has not been
merged to `main`, run by hosted CI, deployed, or tested against a live Workday
site, account, mailbox, or browser profile.

## Recorded outcomes

The controlled happy path ran three times with identical projections. Each run:

- reached mock Review after three completed pages;
- independently verified all ten required fields;
- produced monotonic progress and exactly one terminal result;
- retained sanitized event and evidence projections; and
- left Submit untouched and unrepresentable.

The named fault path also ran three times with identical projections. It stopped
before mutation or navigation and reported exactly:

```text
component=F3 phase=browser step=observe
code=browser_target_invalid retryable=false
```

The local same-commit gate recorded 124/124 architecture, component,
connection, acceptance, and privacy tests and 510/510 tests in the full
Executioner quality suite. The acceptance CLI recorded three happy and three
fault runs.

## Commands

Run this sequence from the repository root on one clean commit:

```text
npm --prefix executioner ci
npm --prefix executioner test -- tests/architecture tests/acceptance/components tests/connections tests/acceptance/s1 tests/security/privacy
npm --prefix executioner run quality
node executioner/scripts/run-s1-acceptance.ts
python ci.py c3
python ci.py all
```

`python ci.py c3` and its `executioner` alias run the built-in npm clean install
before `npm run quality`. The `all` route preserves the existing Python quality
and test commands first, then runs those same two Executioner commands. A router
dry run prints this order without starting subprocesses.

## Acceptance report

The acceptance CLI pins the current full Git SHA before execution and writes:

```text
.runtime/c3-s1-acceptance/<candidate-sha>/report.json
```

The path is gitignored. The JSON report is bounded to 64 KiB and has this
versioned top-level shape:

```text
schemaVersion: 1
candidate: <40-character Git SHA>
repetitions: { happy: 3, fault: 3 }
scenarios: { happy: { runs, projection }, fault: { runs, projection } }
```

Each projection contains terminal and monotonic-progress facts, verified field
IDs and behaviors, final-page state, browser-effect counts, one sanitized
failure fact or `null`, bounded event/evidence projections, privacy assertions,
cleanup confirmation, and `submitTouched: false`. The report omits raw applicant
values, resume bytes, URLs, messages, volatile request/journey/operation/report
identifiers, and other private runtime state.

After the CLI returns, the report's `candidate` must equal `git rev-parse HEAD`
and `git status --short` must remain empty.

## S2 handoff

S2-F0-T1 may start from the accepted Stage 1 Tier 2 commit after the pending
F13 review and coordinator acceptance. S2 owns any new live-site, persistent
browser, secure-account, or mailbox boundary. Stage 1 contributes only the
controlled composition, verification, safety, privacy, deterministic report,
and no-Submit baseline; it does not authorize live execution or deployment.
