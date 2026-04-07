## Hunter (C1)

The **`hunter` Python package** is **C1 (Hunter)**: discovery, enrichment, and C1 operational logging.

Layout under this directory:
- **Runtime modules**: `hunter/*.py` (**`scraper.py`** = C1 discovery entrypoint only, historical name; **`enrich_*.py`**, **`db.py`**, …)
- **C1 tests**: `hunter/tests/`
- **Manual test helpers**: `hunter/devtools/`

Import in code as `from hunter...` (repo root must be on `PYTHONPATH` or run from repo root).

