# DESIGN: Overview

## Overview

The console uses dark forest-green surfaces and a sage accent (`#90d59b`) for primary actions and keyboard focus. Warnings and errors use amber and red.

This is a React SPA (TypeScript, CSS Modules). Token source of truth: `frontend/src/styles/tokens.css`. Component styles: `frontend/src/components/*/`. Page styles: `frontend/src/pages/*/`.

Chart library: **Recharts** (most popular, widest community support in React ecosystem).

Component-specific design notes:

- [C2 Fletcher](c2-fletcher.md): queue/history, PDF-like review surface, inline diff marks, inspector, and provider/privacy warnings.
