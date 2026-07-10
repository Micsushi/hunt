# DESIGN: Overview Page - Redesign

## Overview Page - Redesign

### Remove
- "Jump into the queue" pills strip.
- "Ready now / Blocked / Failed" quick-list panels.
- Hero paragraph text.

### Keep
- Stat cards row (total / pending / enriched / failed / blocked / LinkedIn auth).

### Add

**Service health strip:** inline row of component pills (DB / C1 / C2 / C3 bridge / C4), colour-coded, click navigates to component page.

**Jobs by category - pie/donut chart (switchable):** toggle buttons switch breakdown dimension between: job category / ATS type / source / enrichment status. Click a slice -> navigate to `/jobs` with that filter applied. Uses **Recharts**.

Backend needs: `GET /api/summary/breakdown?field=category|ats_type|source` (simple `GROUP BY`).

**Jobs over time - bar chart:** X = date (default last 30 days), Y = jobs added (`date_scraped`). Window selector: 7d / 30d / 60d / 90d. Breakdown by source (stacked). Uses Recharts.

Backend needs: `GET /api/summary/timeline?days=30` -> `[{ date, count, source }]`.

**Recent activity feed:** last 10 enriched jobs, each row: company / title / status badge / "2h ago". Links to job detail.

---
