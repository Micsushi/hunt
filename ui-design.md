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

OpenSpec change `design.md`, if introduced later, remains technical design and
does not replace this UI contract.
