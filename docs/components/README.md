# Components

**Naming:** Each component has an ID and a code name: **C1 (Hunter)**, **C2 (Trapper)**, **C3 (Executioner)**, **C4 (Coordinator)**. See **`../NAMING.md`** for how that maps to folders (`hunter/`, `trapper/`, `coordinator/`, extension).

**CLI:** **`../CLI_CONVENTIONS.md`** defines how **`hunt` / `hunter`** commands are added so C2–C4 match C1 patterns.

This folder contains the current planning docs for each major part of the system.

- `component1/README.md` : posting discovery and multi-source enrichment (LinkedIn + Indeed)
- `../C1_OPERATOR_WORKFLOW.md` : short C1 v0.1 operator narrative (discovery → enrichment → review)
- `career_ops_prompt_takeaways.md` : prompt-level notes worth revisiting later for C2 (Trapper) and C3 (Executioner)
- `component2/README.md` : resume tailoring (C2: Trapper) overview and stage plan
- `component2/design.md` : resume tailoring data model, runtime layout, and implementation notes
- `../glossary.md` : shared shorthand and terminology
- `component3/README.md` : browser autofill extension (C3: Executioner) overview and stage plan
- `component3/design.md` : browser extension architecture, data model, and rollout notes
- `component4/README.md` : orchestration and submit-control layer (C4: Coordinator), including OpenClaw direction
- `component4/design.md` : orchestration architecture, stage plan details, and browser-agent research notes
- `component4/implementation_checkpoint.md` : current C4 architecture checkpoint, partial implementation status, and restart notes
- `../../todo.md` : live cross-component fix list and sign-off tracker
