# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Hunt is an operator-facing tool for a job seeker managing a personal application pipeline. The primary user monitors discovery and enrichment, prepares tailored resumes, and controls the runtime settings that shape those workflows.

## Product Purpose

Hunt reduces the repeated work of finding suitable jobs, enriching thin listings, and preparing job-specific resume material. Success means the operator can understand pipeline state, adjust behavior safely, and move qualified jobs through the active C0 through C2 workflow with less manual repetition.

## Positioning

Hunt connects job discovery, enrichment, and resume preparation in one operator-controlled pipeline while keeping its runtime components independently useful.

## Operating Context

The React C0 dashboard is the primary operator interface. C1 handles job discovery and enrichment, and C2 Fletcher prepares and reviews tailored resumes. The active workflow currently ends after C2; C3 v3 is not yet part of the running product and C4 is paused.

## Capabilities and Constraints

- C0, C1, and C2 remain independently operable.
- Settings include C1 targeting, filters, schedules, enrichment limits, alerts, C2 provider/runtime controls, resume metadata and prompt policy, desktop notifications, and integration checks.
- C1 file-backed settings and C2 database-backed component settings have different persistence and activation behavior; the interface must state those differences clearly.
- Secrets are write-only and must never be exposed after storage.
- Pipeline states, errors, targets, and next actions must be explicit and cannot rely on color alone.
- Deployments, service restarts, and scheduler changes require separate operator direction.

## Brand Commitments

The product name is Hunt. Its voice is direct, technical, and operational, using stable component names when they clarify ownership without forcing users to navigate by implementation terminology.

## Evidence on Hand

The repository contains the running React frontend, API contracts, representative mock data, the current control-plane behavior, and the established `DESIGN.md` plus `docs/ui-design/` guidance. No customer claims, benchmarks, or public marketing evidence should be invented.

## Product Principles

- Make the next operator action obvious.
- Preserve component independence and exact runtime truth.
- Keep configuration safe through explicit scope, feedback, and activation notes.
- Prefer familiar controls and clear hierarchy over decorative novelty.
- Expose powerful policy controls without making routine settings hard to scan.

## Accessibility & Inclusion

The web interface must support keyboard navigation, visible focus, accessible labels, responsive layouts, and reduced-motion preferences. Status and validation cannot depend on color alone.
