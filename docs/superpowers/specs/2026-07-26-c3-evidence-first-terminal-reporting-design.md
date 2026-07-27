# C3 Evidence-First Terminal Reporting

## Goal

C3 must preserve enough privacy-safe browser and control-plane evidence for an
agent to diagnose a run without reopening the page. C3 may name a cause only
when the page exposes direct, specific evidence. It must not convert weak
signals into CAPTCHA, authentication-success, form-validation, or other guessed
diagnoses.

## Reporting boundary

C3 owns observations, actions, artifacts, and high-confidence page states.
Downstream agents own diagnosis when the evidence is ambiguous.

High-confidence labels are limited to directly observed states:

- `maintenance`
- `job_unavailable`
- `credential_rejected`
- `email_verification_required`
- `apply_entry`
- `auth_form`
- `application_page`
- `review_ready`
- `captcha_present` only with a directly observed challenge

All other unsuccessful outcomes use `unclassified_failure`. The packet may
retain lower-confidence hints, but hints are never promoted to terminal truth.

## Evidence contract

Every terminal operation provides:

1. Page identity: URL, hostname, title, frame URL, document readiness, and
   Workday step.
2. Visible facts: alerts, status messages, validation messages, dialogs,
   headings, relevant body-text excerpts, controls, and buttons.
3. Structural facts: input/control counts and types, auth-form structure,
   application fields, Review/final-submit indicators, and CAPTCHA indicators.
4. Timeline: ordered observations and C3 actions with before/after state keys.
5. Field commitment: requested answer source, available options, selected
   option, committed DOM value, validity state, and rejection reason.
6. Terminal artifacts: redacted DOM, screenshot, field inventory, console and
   navigation/network availability, and artifact identifiers/paths.
7. Control facts: operation state, extension result, watchdog decisions,
   cancellation/reconciliation events, and runner classification.
8. Completeness: missing captures, truncation, probe failures, and conflicts
   between evidence sources.

Passwords, cookies, tokens, and sensitive answer values are never retained.
Field identity, type, presence, validity, change state, and redacted value shape
remain available.

## Precedence and retention

Direct site facts outrank derived control failures. A later loop, timeout,
watchdog event, or artifact error must not erase an earlier visible site alert.
Conflicting sources are preserved and reported as conflicts.

The terminal packet is assembled after terminal reconciliation. Success packets
must not wait for failure-only artifacts. Late specific evidence may enrich the
packet but cannot silently overwrite first-terminal operation truth.

## Stable page observation

After navigation or an auth action, C3 samples until it sees either:

- two matching, non-loading page states; or
- a direct terminal fact such as a credential rejection or maintenance page.

`unknown` and a blank/settling shell never mean authentication succeeded.
Authentication is considered left only when positive application, apply-entry,
Review, verification, or explicit non-auth destination evidence is stable.

## Acceptance

For every audit lane:

1. One reviewer diagnoses from the C3 packet alone.
2. Another reviewer independently inspects browser truth.
3. Their conclusions and retained facts are compared.
4. A packet fails if the browser contains a diagnosis-relevant fact absent from
   the packet, even when C3's label happens to be correct.
