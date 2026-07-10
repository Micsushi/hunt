# DESIGN: Jobs Table - Cleanup

## Jobs Table - Cleanup

### Remove columns
- Queue ("RUN NEXT" badge) - visible on job detail only.
- Source - handled by filter.
- Next retry - visible on job detail.
- Last error - too truncated; move to job detail / tooltip.

### Keep / add
| Column     | Notes |
|------------|-------|
| ID         | Smaller |
| Company    | Keep |
| Title      | Wider |
| Links      | Listing -> / Apply -> |
| Enrichment | Status badge |
| Apply type | Actionable signal |
| Attempts   | Signals stuck rows |
### Visual
- Compact 40px row height.
- Full-row click -> job detail.
- Alternating subtle row tint.
- Sticky header.
- Explicit column widths - no reflow on data change.
- ID: one line, mono, full value visible. No ellipsis.
- Title: one line, clipped with ellipsis and full title tooltip.
- Tag: no visible filter or table column.
