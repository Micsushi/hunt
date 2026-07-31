# DESIGN: Polish Work Checklist

## Polish Work Checklist

### All pages
- [ ] Replace `<pre>` JSON dumps with formatted key-value grids or collapsible panels.
- [x] Move Fletcher out of `_stubs/` into `pages/Fletcher/` with its own CSS module.
- [ ] Consistent panel header: title left, meta/badge right.
- [ ] All timestamps: "2h ago" display, full ISO on hover.
- [ ] Error states: inline banner with message text.
- [ ] Login page: restyle for dark green theme.

### Coordinator

Removed from active polish scope while C4 is paused.
- [ ] Runs table: relative timestamps.
- [ ] "Start run": job picker (type-ahead, default `auto_apply_eligible=TRUE` only; buttons to widen/narrow).

### Fletcher
- [x] Own CSS module.
- [x] Option B active queue and DB-backed Fletcher history.
- [x] File-drop area for uploading base resume `.tex` or text-based `.pdf`.
- [x] PDF-like review workspace with inline diff marks, segment revert, block edit, compile, PDF, and TeX actions.

### C3 v3

Deferred until the v3 runtime reaches a stage that needs an operator surface.

### Settings + LinkedIn Accounts (Ops)
- [ ] Settings: inline Edit + Delete per row.
- [ ] Secrets: "------" with per-row reveal toggle.
- [ ] LinkedIn accounts: Deactivate + Delete per row.
- [ ] LinkedIn auth_state: colour-coded badge.

---
