# DESIGN: Overview

## Overview

Deep forest green dark theme. Feels like a terminal or ops console - focused, low-glare, built for extended operator use. The single muted green accent (`#59a96a`) signals human intent: run, approve, submit. All other UI chrome stays muted.

This is a React SPA (TypeScript, CSS Modules). Token source of truth: `frontend/src/styles/tokens.css`. Component styles: `frontend/src/components/*/`. Page styles: `frontend/src/pages/*/`.

Chart library: **Recharts** (most popular, widest community support in React ecosystem).

Component-specific design notes:

- [C2 Fletcher](c2-fletcher.md): queue/history, PDF-like review surface, inline diff marks, inspector, and provider/privacy warnings.
