# DESIGN: Components

## Components

**Status badges:** pill shape, soft colour background, semantic text colour. States: running/active / error/failed / warning/pending / idle/stopped / unknown.

**Status dots (nav, service health):** 7px circle. Green = ok / amber = degraded / red = down / grey = unknown. Adjacent text label, not inside dot.

**Job table rows:** compact 40px height, clickable (full-row navigates to detail), alternating subtle tint on even rows, sticky header.

**Charts (Recharts):**
- Pie/donut: `#3ecf6e` primary slice, muted palette for secondary slices, tooltip on hover, click-to-filter.
- Area/bar (timeline): accent fill with 0.3 opacity area, accent stroke, grid lines in `border` colour.
- Axis text: text-secondary, mono font.
- Legend: inline above chart, not below.

**Approval queue (Coordinator):** visually distinct - `panel-strong` background, `accent` left border 3px, primary action buttons immediately visible.

**Pipeline status dots (nav + Overview):** green/amber/red/grey as above. Polled every 30s from `/api/system/status`.
