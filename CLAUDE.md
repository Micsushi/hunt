# Hunt : pointer for Claude / Codex

Repo guidance: **`AGENTS.md`**.

Also read:
- **`docs/NAMING.md`** : C0–C4 IDs, code names, folder map
- **`docs/CLI_CONVENTIONS.md`** : operator CLI (`hunter` / `hunterctl`)
- **`docs/roadmap.md`** : priorities, component summary, version snapshot
- **`docs/deployment.md`** : all server2/Ansible/env/path details — canonical, do not duplicate
- **`docs/components/README.md`** : component doc index
- **`docs/DATA_MODEL.md`** : full DB schema, field meanings, owning component
- **`agents/system_prompt.md`** : downstream agent contract

Component docs (read to find next task — feature status + bugs per component):
- **`docs/components/component0/README.md`**, **`runbook.md`**
- **`docs/components/component1/README.md`**, **`runbook.md`**
- **`docs/components/component2/README.md`**, **`runbook.md`**
- **`docs/components/component3/README.md`**, **`runbook.md`**
- **`docs/components/component4/README.md`**, **`runbook.md`**

No dup rules here : extend **`AGENTS.md`** or docs above.

## Doc maintenance

When specs change (new DB fields, business rules, component boundaries, CLI contracts): update `AGENTS.md` and relevant component doc before marking work done.

When new stylistic/workflow preferences are established: add to `AGENTS.md` under Keep In Mind, then compress with caveman skill.

## Cross-platform

All code must run on both Windows (local dev) and Linux (server2). Test locally on Windows before deploying. Never write Linux-only paths or shell assumptions into Python — use `pathlib`, `os.path`, env vars.