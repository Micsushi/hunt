# Components

**Naming:** Each component has an ID and a code name: **C1 (Hunter)**, **C2 (Fletcher)**, **C3 (Executioner)**, **C4 (Coordinator)**. See **`../NAMING.md`** for how that maps to folders (`hunter/`, `fletcher/`, `coordinator/`, extension).

**CLI:** **`../CLI_CONVENTIONS.md`** defines how **`hunt` / `hunter`** commands are added so C2–C4 match C1 patterns.

**Shared terms:** **`../GLOSSARY.md`**

**Live tracker:** **`../TODO.md`**

This folder contains planning docs for each major part of the system.

- `component1/README.md` : posting discovery and multi-source enrichment (LinkedIn + Indeed)
- `../C1_OPERATOR_WORKFLOW.md` : short C1 v0.1 operator narrative (discovery → enrichment → review) and **Production host (server2)** pointers
- `component2/README.md` : resume tailoring (C2: Fletcher) overview and stage plan
- `component2/design.md` : resume tailoring data model, runtime layout, and implementation notes
- `../../fletcher/prompts/README.md` : C2 prompt templates plus **career-ops** reference takeaways (not adopted behavior)
- `component3/README.md` : browser autofill extension (C3: Executioner) overview and stage plan
- `component3/design.md` : browser extension architecture, data model, and rollout notes
- `component4/README.md` : orchestration and submit-control layer (C4: Coordinator), including OpenClaw direction
- `component4/design.md` : orchestration architecture, research notes, and **implementation checkpoint** (living)
