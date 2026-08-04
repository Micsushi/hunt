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

**Buttons and controls:** use the shared 40px control height for normal actions, explicit action labels, visible accent focus, and readable disabled states. Icon-only controls require an accessible label.

**Toggle groups:** use native radio/checkbox controls when the choice is form data. Use `aria-pressed` for button-based filters and segments so visual selection is also exposed to assistive technology.

**Loading, error, and empty states:** loading replacements announce status; errors name the failed resource and recovery; empty states identify the active filter or missing prerequisite. Keep retry actions beside the message.

**Settings targeting:** role-title lanes and experience levels are separate inputs. Engineering and data are always first, extra lane keys are preserved, and C1 save payloads contain `target_job_titles` plus `experience_levels`—never the retired `search_terms` field.

**Settings company policies:** priority and blocked-company lists sit together because they are mutually exclusive discovery outcomes. Blocked companies use exact normalized matching and are rejected before database persistence; existing rows are not silently deleted.

**Settings discovery safety:** the Run settings panel exposes the persistent LinkedIn rate-limit cooldown. The first JobSpy LinkedIn HTTP 429 stops queued LinkedIn searches and future scheduler cycles skip LinkedIn until the cooldown expires; other selected boards continue.
