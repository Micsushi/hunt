# DESIGN: Do's and Don'ts

## Do's and Don'ts

**Do:**
- Use `accent` for exactly one action type per view.
- Use soft colour variants for row highlights and badge backgrounds - never full accent on a large surface.
- Use `mono` for all IDs, timestamps, scores, and log output.
- Use `text-secondary` for all metadata.
- Keep status badges pill-shaped.
- Timestamps: display as "2h ago" with full ISO on hover (title attribute).
- Empty states: short message + call-to-action.

**Don't:**
- No light mode toggle - dark green only.
- No cold Tailwind grays (#6b7280 style) - stay warm green-tinted.
- No multiple accent colours - `#3ecf6e` is the only intent colour.
- No decorative icons in primary buttons - text labels only.
- No card-within-card nesting deeper than one level.
- No `<pre>` JSON dumps as primary UI - use formatted key-value grids or collapsible panels.
