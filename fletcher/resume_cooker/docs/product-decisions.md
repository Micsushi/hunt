# Resume Cooker Product Decisions

These records define durable product and integration behavior. Task pages may refine implementation
details but must not contradict accepted decisions without updating this file and documenting a
compatibility impact.

## D1: ATS Variant Ownership

- **Status:** Accepted
- **Date:** 2026-07-22
- **Decision:** Use a hybrid model. Caller-provided resume source is authoritative. Resume Cooker may
  ship and maintain an optional ATS-safe variant or generator, but generated variants cannot invent
  or rewrite claims.
- **Rationale:** A useful local tool should demonstrate ATS-safe output without taking ownership of
  another system's canonical candidate data.
- **Consequences:** Variant comparison must protect normalized facts and selected strengths. Saved
  output remains explicit. Callers may ignore the bundled variant and validate their own.
- **Implementation follow-ups:** RC-004.2, RC-004.3, RC-009.1.
- **Revisit when:** A structured resume model becomes the canonical authoring surface.

## D2: Page-Limit Severity

- **Status:** Accepted
- **Date:** 2026-07-22
- **Decision:** The ATS profile defaults to a one-page blocker when page count is measurable. An
  unavailable count is an incomplete warning for ordinary local runs and an unavailable-required-
  capability error for strict release validation. A caller may supply a different versioned policy.
- **Rationale:** ATS output needs a useful default while downstream products retain policy control.
- **Consequences:** Reports must distinguish over-limit, unknown count, and unavailable required
  capability. Documentation must not describe every page-limit result as warning-only.
- **Implementation follow-ups:** RC-002.2, RC-004.5, RC-007.1.
- **Revisit when:** Product targets routinely require multi-page resumes.

## D3: Pre-C2 Enforcement

- **Status:** Accepted
- **Date:** 2026-07-22
- **Decision:** Hunt owns orchestration policy. Its default policy blocks Fletcher on preflight
  `fail`, allows `pass_with_warnings` with visible flags, and permits only explicit audited
  overrides. Resume Cooker returns evidence and a recommendation; it does not launch or block
  Fletcher itself.
- **Rationale:** Quality analysis and workflow authority have different owners.
- **Consequences:** Overrides retain original reports, approver identity, reason, and timestamp.
  Missing, malformed, or timed-out required reports cannot become implicit passes.
- **Implementation follow-ups:** RC-008.3, RC-008.5, RC-008.6.
- **Revisit when:** Hunt introduces a centralized policy engine with equivalent audit guarantees.

## D4: Postflight Inputs

- **Status:** Accepted
- **Date:** 2026-07-22
- **Decision:** Structured resume JSON is authoritative for normalized candidate facts when supplied.
  Source text or LaTeX is authoritative for source-preservation checks. Generated PDF and extracted
  text are authoritative for artifact checks.
- **Rationale:** No single representation can prove both factual identity and final PDF quality.
- **Consequences:** Structured data takes precedence for exact fact comparison. Source-only runs may
  emit lower-confidence findings. A JD can guide match and grounding analysis but never prove a
  candidate fact. Configured identity, education, and experience locations are immutable after
  case/whitespace normalization and common region-abbreviation normalization; ambiguous location
  equivalence produces review warning rather than silent match.
- **Implementation follow-ups:** RC-004.1 through RC-004.6.
- **Revisit when:** Fletcher and Resume Cooker share a versioned canonical resume schema.

## D5: Tester Priority And Requiredness

- **Status:** Accepted
- **Date:** 2026-07-22
- **Decision:** ATS-Checker is the first complete tester integration and is required only for the
  strict release-validation profile. Normal local checks keep all tester dependencies optional.
  ResumeParser follows, then ats-screener. Resume-Matcher remains optional until a bounded local
  operation proves useful.
- **Rationale:** Independent parser evidence matters, but third-party dependency weight must not make
  the root project or ordinary offline checks fragile.
- **Consequences:** Skips are explicit and never executed passes. Strict mode fails with unavailable
  capability when its required tester cannot run.
- **Implementation follow-ups:** RC-003.1 through RC-003.6.
- **Revisit when:** A tester becomes lightweight, stable, and suitable for root installation.

## D6: API Review Scope

- **Status:** Accepted
- **Date:** 2026-07-22
- **Decision:** OpenRouter and Anthropic remain supported opt-in providers. API review is advisory,
  bounded by input, output, timeout, request, and spend limits, and cannot be the sole hard blocker.
  A key alone never enables a request.
- **Rationale:** Model review can add judgment but cannot replace deterministic evidence or explicit
  privacy consent.
- **Consequences:** Reports record whether content left the machine. Raw private prompts and model
  responses are not retained by default. Provider failures do not crash unrelated local checks.
- **Implementation follow-ups:** RC-005.1 through RC-005.4, RC-009.7.
- **Revisit when:** Provider retention, consent, or audit requirements change.

## D7: CLI And Report Compatibility

- **Status:** Accepted
- **Date:** 2026-07-22
- **Decision:** Stable CLI commands are `tools`, `build`, `preview`, `check`, `compare`, and `testers`.
  Reports carry a schema version and stable check IDs. JSON mode writes only JSON to stdout; human
  diagnostics use stderr.
- **Exit codes:**
  - `0`: command completed with `pass` or `pass_with_warnings`;
  - `2`: command completed with quality status `fail`;
  - `64`: invalid usage or required input;
  - `69`: required capability unavailable;
  - `70`: internal or unexpected failure.
- **Rationale:** Callers should consume structured status instead of parsing prose. Warnings indicate
  completed evaluation, not a process failure.
- **Consequences:** Breaking schema or command changes require a versioned migration. npm scripts may
  remain compatibility aliases.
- **Implementation follow-ups:** RC-007.1 through RC-007.6.
- **Revisit when:** A published package requires formal semantic-version guarantees.

## D8: UI Ownership Boundary

- **Status:** Accepted
- **Date:** 2026-07-22
- **Decision:** UI v1 edits raw LaTeX inside approved workspace roots, runs backend operations,
  displays reports, and keeps temporary preview separate from intentional saved output. It does not
  own structured resume data or automatic rewriting.
- **Rationale:** Raw-LaTeX editing extends the existing preview without introducing a second source
  of truth.
- **Consequences:** Safe file access, conflict detection, stale-operation protection, and explicit
  save/build actions are required. Structured authoring and native packaging remain deferred.
- **Implementation follow-ups:** RC-009.1 through RC-009.8.
- **Revisit when:** Structured resume editing has its own schema, migration, and ownership design.

## D9: Windows-First Runtime Boundary

- **Status:** Accepted
- **Date:** 2026-07-26
- **Decision:** Windows 11 is the supported product environment through Stages 1-4. Node.js
  orchestration, reports, saved output, preview, and browser access run on the host. Docker Desktop
  is the recommended provider for short-lived TeX and Poppler containers. Full application
  containerization and Docker Compose are not part of the initial product.
- **Rationale:** Containers remove heavyweight PDF-tool installation drift without forcing Windows
  paths, file watching, browser access, ports, process cleanup, and editor integration through a
  Linux application boundary.
- **Consequences:** Containers mount only the selected project workspace, write ignored staging
  output, and receive no home directory, credentials, Docker socket, browser state, or unrelated
  drives. Preview remains host-side and loopback-only. Native Windows PDF tools are optional.
  macOS/Linux support is deferred to Stage 5.
- **Implementation follow-ups:** RC-002.1 through RC-002.3, RC-007.6, RC-009.8, RC-010.1 through
  RC-010.4.
- **Revisit when:** Native packaging, remote service deployment, or measured cross-platform failures
  make the narrow tool-container boundary insufficient.
