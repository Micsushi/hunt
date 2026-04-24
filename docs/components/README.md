# Components

**Naming**: C1 (Hunter), C2 (Fletcher), C3 (Executioner), C4 (Coordinator). Folder map: `../NAMING.md`.

**CLI conventions**: `../CLI_CONVENTIONS.md`

**Shared terms**: `../GLOSSARY.md`

**DB schema**: `../DATA_MODEL.md`

**API contracts**: `../API_CONTRACTS.md`

**Settings/secrets**: `../SETTINGS_AND_SECRETS.md`

**Deployment**: `../deployment.md`

---

**Standalone rule**: C0 + DB required base — works without other components. C1/C2/C3: standalone (CLI + DB). C4 only intentionally coupled: depends on C1/C2 outputs + live C3.

**API gateway rule**: C0 backend single gateway. All component API calls route through it. Frontend never calls component services directly.

**C3 rule**: Chrome extension, operator's local machine — no server container. Polls C0 for fill requests. Posts fill results to C0; backend/C4 do DB writes. No DB credentials.

---

Each component has two docs:

| Doc | Purpose | When to read |
|---|---|---|
| `README.md` | Feature status: done / in-progress / bugs + locked decisions + contract | Finding next thing to work on |
| `runbook.md` | Operational how-to: commands, setup, recovery | Running or debugging the component |
| `api.md` / `backend-contract.md` | HTTP/service contract where applicable | Wiring C0 gateway or component service APIs |

---

## Components

- `component0/` : C0 (Frontend) — operator dashboard SPA (`frontend/`)
- `component1/` : C1 (Hunter) — discovery and enrichment
- `component2/` : C2 (Fletcher) — resume tailoring
- `component3/` : C3 (Executioner) — browser autofill extension
- `component4/` : C4 (Coordinator) — orchestration and submit control
