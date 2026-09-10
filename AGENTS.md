# Hunt contributor guidance

## Scope

Read the README, `docs/NAMING.md`, the relevant component guide, and the
affected source entrypoint before editing. Keep C0, C1, and C2 changes scoped
to their owning components and preserve the interfaces between them. Confirm
current behavior from source and documentation before recording a status claim.

## UI work

For UI work, inspect the current repository UI, source, and docs, then use a
relevant installed skill when available. Preserve project conventions,
accessibility, responsive behavior, and reversal behavior; keep UI copy concise
and actionable; validate the actual user flow. Do not require a new UI file or
private dependency solely to begin focused work.

## Command entrypoints

Create a local environment with `python3 -m venv venv`, install Hunter's
dependencies with `pip install -r hunter/requirements.txt`, and serve the local
UI with the tracked platform launcher `./hunter.sh ui serve` or
`.\hunter.ps1 ui serve` on PowerShell. The grouped repository entrypoints are:

```text
python ci.py c1
python test.py c1
python quality.py c1
python smoke.py c1
```

The `ci.py` and `quality.py` wrappers also support `c0`, `c2`, `shared`, and
`frontend`. The `test.py` wrapper also supports `c0`, `c2`, and `shared`. The
smoke wrapper supports `all`, `c0`, `c1`, `c2`, `review`, `server2`,
`server2-c0`, and `server2-c1`, plus the `full`, `hunter`, and `fletcher`
aliases. Use the smallest matching group first and expand only when the change
crosses component boundaries. Keep deployment commands separate from local
checks.

## Data and documentation

Keep `.env` files, tokens, saved sessions, job applicant data, local databases,
and generated artifacts out of commits. Preserve the existing `easy_apply`
classification and downstream exclusion unless the owning contract changes.
Put user-facing instructions in the README or `docs/`; keep contributor
guidance here. Do not commit temporary plans or local-only instructions.
