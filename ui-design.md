# UI Design

Hunt uses a dark olive-green, data-dense control dashboard for the job pipeline.

## Required Sources

- Machine-readable tokens and detailed rules: `DESIGN.md`
- Supporting UI guidance: `docs/ui-design/`
- Primary frontend: `frontend/`

## Rules

- Keep pipeline state, errors, source, age, and next actions easy to scan.
- Preserve component independence; C0 must remain useful without C4.
- Use exact state labels and never rely on color alone.
- Keep review and automation actions explicit about their target and status.
- Update `DESIGN.md` when stable visual tokens change.

## Standard Page Structure

- Start with one `h1`, a concise operational description, and only the actions that apply to the whole page.
- Group related controls under descriptive `h2`/`h3` headings. Avoid nested cards; use spacing and dividers inside one surface.
- Put a control's label, hint, validation, and status together. Placeholder text is an example, not a label.
- Keep primary actions at the end of their section. Name the result (`Save targeting`, `Refresh logs`) instead of using generic labels.

## Interaction Contract

- Every interactive element must work with the keyboard and show the shared accent focus ring.
- Selected toggles expose state with native inputs or `aria-pressed`; disclosures expose `aria-expanded`.
- Interactive controls use a 40px default minimum height. Compact table controls may be smaller only when their label and focus target remain clear.
- Disabled controls remain readable, use `not-allowed`, and must not be the only explanation for why an action is unavailable.
- Respect `prefers-reduced-motion`: remove decorative transitions and animations without hiding state changes.

## Feedback and States

- Loading messages use `role="status"` when they replace page or section content.
- Errors use `role="alert"`, name what failed, and state the recovery action. Do not show only `Failed to load`.
- Empty states explain which filter or prerequisite produced the result and how to continue.
- Save feedback is section-scoped: show saving, success, and failure next to the action that initiated it; do not imply unrelated settings were saved.
- Preserve entered values after a failed save so the user can retry.

## Responsive Behavior

- Pages must not create document-level horizontal overflow at 390px. Data tables may scroll inside a labeled container.
- Stack page headers and action groups on narrow screens; full-width primary actions are preferred when space is constrained.
- Settings tabs remain keyboard-navigable and horizontally scrollable on small screens without truncating the active label.

## Settings Information Architecture

- `Targeting` owns C1 role titles, experience levels, locations, and job boards.
- `Automation` owns C1 cadence, result limits, enrichment, and advanced runtime controls.
- `Resume` owns C2 tailoring and provider controls.
- `System` owns persistence status, integrations, and maintenance links.
- C1 targeting uses `target_job_titles` and `experience_levels`. The retired `search_terms` field must never appear in the UI or save payload.
- Engineering and data are the fixed primary lanes; render any additional configured lanes after them and preserve those keys on save.

OpenSpec change `design.md`, if introduced later, remains technical design and
does not replace this UI contract.
