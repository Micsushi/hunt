# Components

**Naming**: C1 (Hunter), C2 (Fletcher), C3 (Executioner), C4 (Coordinator). Folder map: `../NAMING.md`.

**CLI conventions**: `../CLI_CONVENTIONS.md`

**Shared terms**: `../GLOSSARY.md`

**DB schema**: `../DATA_MODEL.md`

**Deployment**: `../deployment.md`

---

**Shared rule**: components should be independently runnable for local testing and debugging. C0 should work through `backend/app.py` against DB/artifact state even when other runtimes are down. C1/C2/C3 should keep standalone terminal/manual entrypoints. C4 is the only intentionally coupled component because it orchestrates C1/C2/C3 rather than replacing their standalone workflows.

---

Each component has two docs:

| Doc | Purpose | When to read |
|---|---|---|
| `README.md` | Feature status: done / in-progress / bugs + locked decisions + contract | Finding next thing to work on |
| `runbook.md` | Operational how-to: commands, setup, recovery | Running or debugging the component |

---

## Components

- `component0/` : C0 (Frontend) — operator dashboard SPA (`frontend/`)
- `component1/` : C1 (Hunter) — discovery and enrichment
- `component2/` : C2 (Fletcher) — resume tailoring
- `component3/` : C3 (Executioner) — browser autofill extension
- `component4/` : C4 (Coordinator) — orchestration and submit control
