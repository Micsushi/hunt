---
version: 1
slug: "frontend-src-pages-settings-index-tsx"
primary_target: "frontend/src/pages/Settings/index.tsx"
related_targets: ["frontend/src/pages/Settings/Settings.module.css"]
---

## Scope and mode

Operate-mode redesign of the existing Settings route. Preserve Hunt's established dark olive visual system and every current control while replacing component-first navigation with task-first navigation.

## Audience, job, and action

The Hunt operator needs to tune discovery targets, automation cadence, resume behavior, notifications, and integrations without scanning unrelated controls. Each save must show its scope and result clearly.

## Constraints

- Keep C1 file-backed and C2 database-backed persistence behavior explicit.
- Preserve secrets as write-only values.
- Support keyboard tab navigation, visible focus, narrow screens, reduced motion, and non-color status cues.
- Stay integration-ready for C1 `target_job_titles` and `experience_levels` without copying the parallel worktree.

## Direction

A compact settings overview leads into four intent-based tabs: Targeting, Automation, Resume, and System. The active tab owns a focused content region with a short purpose statement, operational status cues, and scoped save actions. Dense advanced resume policy remains available but is visually separated from routine controls.

## Memorable moment

The tab rail reads like a pipeline control strip: each destination names the operator outcome first and the internal owner second, so the page stays legible even as components evolve.

## Unresolved

The C1 targeting branch must be reconciled during integration so its added fields land inside the Targeting tab and share the redesigned panel grammar.
