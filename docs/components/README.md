# Components

**Naming**: C1 (Hunter), C2 (Fletcher), C3 (Executioner), C4 (Coordinator). Folder map: `../NAMING.md`.

**CLI conventions**: `../CLI_CONVENTIONS.md`

**Shared terms**: `../GLOSSARY.md`

**DB schema**: `../DATA_MODEL.md`

**API contracts**: `../API_CONTRACTS.md`

**Settings/secrets**: `../SETTINGS_AND_SECRETS.md`

**Deployment**: `../deployment.md`

---

**Shared rule**: components should be independently runnable for local testing and debugging. C0 + DB is the required base layer — it works without any other component running. C1/C2/C3 each work standalone (CLI + DB when available). C4 is the only intentionally coupled component: it depends on C1/C2 outputs and a live C3 session to do anything useful.

**API gateway rule**: the C0 backend is the single gateway. All component API calls from the frontend route through the C0 backend. Components expose small service APIs; the backend calls them. The frontend never calls component services directly.

**C3 special rule**: C3 is a Chrome extension running on the operator's local machine — not a server container. It polls the C0 backend for pending fill requests when in pipeline mode. It posts fill results back to C0; backend/C4 perform DB writes. C3 must not receive DB credentials.

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
