# DESIGN: Logs Page - Redesign

## Logs Page - Redesign

### Problems
- No filtering, no search, no service selector, not compact.

### Requirements
- **Service tabs:** All / C0 / C1 / C2 / C3 bridge / C4 / DB.
- **Search:** Free-text client-side filter on message content.
- **Level filter:** All / ERROR / WARN / INFO / DEBUG (multi-select).
- **Time filter:** 1h / 6h / 24h / 7d - default 24h.
- **Load more:** 100 rows at a time, "Load more" at bottom.
- **Compact rows:** timestamp (mono) / level badge / service tag / message. Single line, expandable on click.
- **Auto-refresh toggle:** off by default, 15s interval option.

Backend: extend `/api/logs` with `service`, `level`, `since` query params if not present.

---
