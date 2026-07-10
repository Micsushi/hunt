# DESIGN: Nav Status Indicators

## Nav Status Indicators

Each nav link shows a live status dot - no need to enter a page to know if a component is up.

- Poll `/api/system/status` every **30s** in Layout. Silent failure -> grey dot.
- Dot: 7px circle appended after the nav label.
- States: green (ok) / amber (degraded) / red (down) / grey (unknown).
- No dot for Overview / Jobs / Logs (always accessible).

| Nav item    | Signal source             |
|-------------|---------------------------|
| Ops         | DB + C1 reachable         |
| Fletcher    | C2 reachable (`c2.ok`)    |
| Executioner | C3 bridge (`c3_bridge.ok`)|
| Coordinator | C4 reachable (`c4.ok`)    |

---
