# DB Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `component_settings` + `linkedin_accounts` tables (Phase 1) and wire all components to a shared Postgres-compatible connection factory (Phase 2a), so the system can run against SQLite locally and Postgres in production with zero code-path divergence.

**Architecture:** A new `hunter/db_compat.py` module owns the single `get_connection()` factory. Each component's existing `get_connection()` becomes a thin wrapper that calls through to it. The compat layer translates `?` → `%s` placeholders so all existing SQL is untouched. Two new tables (`component_settings`, `linkedin_accounts`) land in `hunter/db.py`'s `init_db()` via `CREATE TABLE IF NOT EXISTS`.

**Tech Stack:** Python 3.11, sqlite3 (local), psycopg2-binary (Postgres target), cryptography (Fernet AES for linkedin password), pytest.

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `hunter/db_compat.py` | Shared connection factory; SQLite + Postgres compat wrappers |
| Create | `hunter/crypto.py` | Fernet encrypt/decrypt for `linkedin_accounts.password_encrypted` |
| Create | `schema/postgres_schema.sql` | Full Postgres DDL for all 8 tables |
| Modify | `hunter/db.py` | Add new table DDL + `init_db()` creates them; delegate `get_connection()` to `db_compat` |
| Modify | `hunter/config.py` | Add `HUNT_DB_URL`, `HUNT_CREDENTIAL_KEY` env vars |
| Modify | `fletcher/db.py` | Delegate `get_connection()` to `hunter.db_compat` |
| Modify | `coordinator/db.py` | Delegate `get_connection()` to `hunter.db_compat` |
| Modify | `.env.example` | Document new vars |
| Create | `tests/test_db_compat.py` | Compat layer unit tests |
| Create | `tests/test_new_tables.py` | component_settings + linkedin_accounts tests |

---

## Task 1: Create `hunter/db_compat.py`

**Files:**
- Create: `hunter/db_compat.py`

- [ ] **Step 1: Write the file**

```python
"""Shared DB connection factory for all Hunt components.

SQLite is used when HUNT_DB_URL is absent (local dev).
Postgres (psycopg2) is used when HUNT_DB_URL is set (production).

All existing SQL uses ? placeholders (SQLite style).
The Postgres wrapper translates ? → %s transparently.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path


def get_connection(db_path: str | Path | None = None):
    """Return a DB connection for the current environment.

    Pass db_path to override HUNT_DB_PATH (SQLite only; ignored for Postgres).
    Returns a sqlite3.Connection or _PgConnCompat depending on HUNT_DB_URL.
    """
    db_url = (os.environ.get("HUNT_DB_URL") or "").strip()
    if db_url:
        return _pg_connect(db_url)
    return _sqlite_connect(db_path)


# ---------------------------------------------------------------------------
# SQLite path
# ---------------------------------------------------------------------------

def _sqlite_connect(db_path: str | Path | None) -> sqlite3.Connection:
    from hunter.config import DB_PATH  # avoid circular at module level

    path = str(db_path) if db_path else (os.getenv("HUNT_DB_PATH") or "").strip() or DB_PATH
    conn = sqlite3.connect(path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        pass
    return conn


# ---------------------------------------------------------------------------
# Postgres path
# ---------------------------------------------------------------------------

def _pg_connect(db_url: str) -> "_PgConnCompat":
    import psycopg2
    import psycopg2.extras

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    return _PgConnCompat(conn)


def _pg_sql(query: str) -> str:
    """Translate SQLite dialect → Postgres dialect."""
    query = query.replace("?", "%s")
    # SQLite-only PRAGMA lines become no-ops
    if query.strip().startswith("PRAGMA"):
        return "SELECT 1"
    # SQLite BEGIN IMMEDIATE → standard Postgres BEGIN
    query = query.replace("BEGIN IMMEDIATE", "BEGIN")
    return query


class _PgConnCompat:
    """Makes a psycopg2 connection behave like sqlite3 for Hunt's usage patterns."""

    def __init__(self, conn):
        self._conn = conn

    def cursor(self) -> "_PgCursorCompat":
        import psycopg2.extras

        return _PgCursorCompat(
            self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        )

    def execute(self, query: str, params=()) -> "_PgCursorCompat":
        cur = self.cursor()
        cur.execute(query, params)
        return cur

    def executemany(self, query: str, param_list) -> "_PgCursorCompat":
        cur = self.cursor()
        cur.executemany(query, param_list)
        return cur

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        self._conn.close()

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type:
            self._conn.rollback()
        else:
            self._conn.commit()
        return False


class _PgCursorCompat:
    """Wraps psycopg2 RealDictCursor to match sqlite3.Cursor interface."""

    def __init__(self, cur):
        self._cur = cur
        self.lastrowid: int | None = None

    def execute(self, query: str, params=()) -> "_PgCursorCompat":
        query = _pg_sql(query)
        self._cur.execute(query, params if params else None)
        # Capture RETURNING id if present
        if "RETURNING" in query.upper():
            row = self._cur.fetchone()
            if row:
                self.lastrowid = row.get("id") or row.get(list(row.keys())[0])
        return self

    def executemany(self, query: str, param_list) -> "_PgCursorCompat":
        query = _pg_sql(query)
        self._cur.executemany(query, param_list)
        return self

    def fetchone(self):
        row = self._cur.fetchone()
        return dict(row) if row else None

    def fetchall(self):
        return [dict(r) for r in self._cur.fetchall()]

    def fetchmany(self, size: int):
        return [dict(r) for r in self._cur.fetchmany(size)]

    def __iter__(self):
        for row in self._cur:
            yield dict(row)

    @property
    def rowcount(self) -> int:
        return self._cur.rowcount
```

- [ ] **Step 2: Verify file exists**

```bash
python -c "from hunter.db_compat import get_connection; print('ok')"
```
Expected: `ok`

- [ ] **Step 3: Commit**

```bash
git add hunter/db_compat.py
git commit -m "add db_compat connection factory (sqlite/postgres)"
```

---

## Task 2: Create `hunter/crypto.py`

**Files:**
- Create: `hunter/crypto.py`

Needed for encrypting `linkedin_accounts.password_encrypted`. Uses Fernet (AES-128-CBC + HMAC-SHA256).

- [ ] **Step 1: Install dependency**

```bash
pip install cryptography
```

Add `cryptography` to `hunter/requirements.txt`.

- [ ] **Step 2: Write the file**

```python
"""Fernet encrypt/decrypt for secrets stored in DB (linkedin passwords)."""

from __future__ import annotations

import os
from functools import lru_cache


@lru_cache(maxsize=1)
def _get_fernet():
    key = (os.environ.get("HUNT_CREDENTIAL_KEY") or "").strip()
    if not key:
        raise RuntimeError(
            "HUNT_CREDENTIAL_KEY is not set. "
            "Generate one with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    from cryptography.fernet import Fernet

    return Fernet(key.encode() if isinstance(key, str) else key)


def encrypt(plaintext: str) -> str:
    """Encrypt a string and return a base64 token."""
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt(token: str) -> str:
    """Decrypt a Fernet token and return the original string."""
    return _get_fernet().decrypt(token.encode()).decode()


def credential_key_is_set() -> bool:
    return bool((os.environ.get("HUNT_CREDENTIAL_KEY") or "").strip())
```

- [ ] **Step 3: Verify**

```bash
python -c "
import os
from cryptography.fernet import Fernet
os.environ['HUNT_CREDENTIAL_KEY'] = Fernet.generate_key().decode()
from hunter.crypto import encrypt, decrypt
assert decrypt(encrypt('secret')) == 'secret'
print('ok')
"
```
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add hunter/crypto.py hunter/requirements.txt
git commit -m "add crypto helpers for linkedin account passwords"
```

---

## Task 3: Add new tables to `hunter/db.py`

**Files:**
- Modify: `hunter/db.py`

Add `COMPONENT_SETTINGS_TABLE_SQL`, `LINKEDIN_ACCOUNTS_TABLE_SQL` constants and call them in `init_db()`.

- [ ] **Step 1: Write failing test** (in `tests/test_new_tables.py`)

```python
"""Tests for component_settings and linkedin_accounts tables."""

import os
import tempfile
import pytest
from hunter.db import init_db, get_connection


@pytest.fixture
def db(tmp_path):
    db_file = tmp_path / "test.db"
    os.environ["HUNT_DB_PATH"] = str(db_file)
    # Remove HUNT_DB_URL so we use SQLite
    os.environ.pop("HUNT_DB_URL", None)
    init_db(maintenance=False)
    conn = get_connection()
    yield conn
    conn.close()
    os.environ.pop("HUNT_DB_PATH", None)


def test_component_settings_table_exists(db):
    rows = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='component_settings'"
    ).fetchall()
    assert len(rows) == 1


def test_component_settings_insert_and_read(db):
    db.execute(
        """
        INSERT INTO component_settings (component, key, value, value_type, secret, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        ("C1", "enrichment_batch_limit", "25", "int", 0, "test"),
    )
    db.commit()
    row = db.execute(
        "SELECT * FROM component_settings WHERE component = ? AND key = ?",
        ("C1", "enrichment_batch_limit"),
    ).fetchone()
    assert row is not None
    assert row["value"] == "25"
    assert row["value_type"] == "int"
    assert row["secret"] == 0


def test_component_settings_primary_key_conflict(db):
    db.execute(
        "INSERT INTO component_settings (component, key, value, value_type, updated_by) VALUES (?,?,?,?,?)",
        ("C2", "model_name", "gemma2:9b", "string", "test"),
    )
    db.commit()
    import sqlite3
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO component_settings (component, key, value, value_type, updated_by) VALUES (?,?,?,?,?)",
            ("C2", "model_name", "other", "string", "test"),
        )
        db.commit()


def test_linkedin_accounts_table_exists(db):
    rows = db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='linkedin_accounts'"
    ).fetchall()
    assert len(rows) == 1


def test_linkedin_accounts_insert_and_read(db):
    db.execute(
        """
        INSERT INTO linkedin_accounts (username, password_encrypted, display_name, active, auth_state)
        VALUES (?, ?, ?, ?, ?)
        """,
        ("user@example.com", "enc_token_here", "Test User", 1, "unknown"),
    )
    db.commit()
    row = db.execute(
        "SELECT * FROM linkedin_accounts WHERE username = ?", ("user@example.com",)
    ).fetchone()
    assert row is not None
    assert row["display_name"] == "Test User"
    assert row["active"] == 1
    assert row["auth_state"] == "unknown"


def test_linkedin_accounts_username_unique(db):
    db.execute(
        "INSERT INTO linkedin_accounts (username, active) VALUES (?, ?)",
        ("dup@example.com", 1),
    )
    db.commit()
    import sqlite3
    with pytest.raises(sqlite3.IntegrityError):
        db.execute(
            "INSERT INTO linkedin_accounts (username, active) VALUES (?, ?)",
            ("dup@example.com", 1),
        )
        db.commit()
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
pytest tests/test_new_tables.py -v
```
Expected: FAIL with `OperationalError: no such table: component_settings`

- [ ] **Step 3: Add table DDL constants to `hunter/db.py`**

After `RUNTIME_STATE_TABLE_SQL`, add:

```python
COMPONENT_SETTINGS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS component_settings (
    component   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    value_type  TEXT NOT NULL DEFAULT 'string',
    secret      BOOLEAN NOT NULL DEFAULT 0,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by  TEXT,
    PRIMARY KEY (component, key)
)
"""

LINKEDIN_ACCOUNTS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS linkedin_accounts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    username            TEXT NOT NULL UNIQUE,
    password_encrypted  TEXT,
    display_name        TEXT,
    active              BOOLEAN NOT NULL DEFAULT 1,
    auth_state          TEXT NOT NULL DEFAULT 'unknown',
    last_auth_check     TEXT,
    last_auth_error     TEXT,
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)
"""
```

- [ ] **Step 4: Wire into `init_db()`**

In `init_db()`, after `cursor.execute(RUNTIME_STATE_TABLE_SQL)`, add:

```python
        cursor.execute(COMPONENT_SETTINGS_TABLE_SQL)
        cursor.execute(LINKEDIN_ACCOUNTS_TABLE_SQL)
```

- [ ] **Step 5: Run tests — expect PASS**

```bash
pytest tests/test_new_tables.py -v
```
Expected: 6 PASS

- [ ] **Step 6: Commit**

```bash
git add hunter/db.py tests/test_new_tables.py
git commit -m "add component_settings and linkedin_accounts tables"
```

---

## Task 4: Update `hunter/config.py` — new env vars

**Files:**
- Modify: `hunter/config.py`

- [ ] **Step 1: Add vars**

Find the block where `HUNT_DB_PATH` is defined and add after it:

```python
# Postgres connection URL. When set, overrides SQLite (HUNT_DB_PATH).
# Format: postgresql://user:password@host:5432/dbname
HUNT_DB_URL = (os.getenv("HUNT_DB_URL") or "").strip()

# Fernet key for encrypting linkedin_accounts.password_encrypted.
# Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
HUNT_CREDENTIAL_KEY = (os.getenv("HUNT_CREDENTIAL_KEY") or "").strip()
```

- [ ] **Step 2: Update `.env.example`**

Add a new section at the top of `.env.example`:

```bash
# ---- Database ----
# Leave HUNT_DB_URL blank to use SQLite (local dev default).
# Set to a Postgres URL for production:
# HUNT_DB_URL=postgresql://hunt:password@localhost:5432/hunt
# HUNT_DB_PATH=hunt.db   # SQLite path (used when HUNT_DB_URL is absent)

# ---- Credential encryption ----
# Required when using linkedin_accounts table.
# Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
# HUNT_CREDENTIAL_KEY=
```

- [ ] **Step 3: Commit**

```bash
git add hunter/config.py .env.example
git commit -m "add HUNT_DB_URL and HUNT_CREDENTIAL_KEY config vars"
```

---

## Task 5: Wire `hunter/db.py` to use `db_compat`

**Files:**
- Modify: `hunter/db.py`

Replace the existing `get_connection()` body so it delegates to `db_compat`. Also add `RETURNING id` to the single `INSERT INTO jobs` call that uses `cursor.lastrowid`.

- [ ] **Step 1: Replace `get_connection()` in `hunter/db.py`**

Old (lines 502-511):
```python
def get_connection():
    db_path = (os.getenv("HUNT_DB_PATH") or "").strip() or DB_PATH
    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        pass
    return conn
```

New:
```python
def get_connection():
    from hunter.db_compat import get_connection as _get_connection

    return _get_connection()
```

- [ ] **Step 2: Fix `lastrowid` in `add_job()`**

`add_job()` uses `cursor.lastrowid` after an INSERT (line ~1492). Update the INSERT to include `RETURNING id` so the Postgres compat layer captures it:

Old:
```python
            cursor.execute(
                f"""
                INSERT INTO jobs ({columns_sql})
                VALUES ({placeholders})
                """,
                values,
            )
            conn.commit()
            return "inserted", cursor.lastrowid
```

New:
```python
            cursor.execute(
                f"""
                INSERT INTO jobs ({columns_sql})
                VALUES ({placeholders})
                RETURNING id
                """,
                values,
            )
            conn.commit()
            return "inserted", cursor.lastrowid
```

Note: SQLite supports `RETURNING` since 3.35 (2021). Minimum Python 3.11 + bundled SQLite is fine.

- [ ] **Step 3: Run existing tests**

```bash
pytest tests/test_new_tables.py tests/test_stage1.py tests/test_stage2.py -v
```
Expected: same pass/fail as before

- [ ] **Step 4: Commit**

```bash
git add hunter/db.py
git commit -m "delegate hunter get_connection to db_compat; add RETURNING id to insert"
```

---

## Task 6: Wire `fletcher/db.py` to use `db_compat`

**Files:**
- Modify: `fletcher/db.py`

fletcher has `get_connection(db_path=None)`. It also uses `cursor.lastrowid` in two places (lines 193, 250). Both are `INSERT INTO resume_attempts` and `INSERT INTO resume_versions`.

- [ ] **Step 1: Replace `get_connection()` in `fletcher/db.py`**

Old (lines 108-112):
```python
def get_connection(db_path: str | Path | None = None) -> sqlite3.Connection:
    path = Path(db_path or get_db_path())
    conn = sqlite3.connect(path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    return conn
```

New:
```python
def get_connection(db_path: str | Path | None = None):
    from hunter.db_compat import get_connection as _get_connection

    return _get_connection(db_path)
```

- [ ] **Step 2: Read lines 185-260 in fletcher/db.py to find the exact INSERT statements**

```bash
sed -n '185,260p' fletcher/db.py
```

Then add `RETURNING id` to `INSERT INTO resume_attempts` and `INSERT INTO resume_versions`, similar to Task 5 Step 2.

- [ ] **Step 3: Run fletcher tests**

```bash
pytest tests/test_component2_pipeline.py tests/test_component2_stage1.py -v
```
Expected: same pass/fail as before

- [ ] **Step 4: Commit**

```bash
git add fletcher/db.py
git commit -m "delegate fletcher get_connection to db_compat; fix RETURNING id"
```

---

## Task 7: Wire `coordinator/db.py` to use `db_compat`

**Files:**
- Modify: `coordinator/db.py`

coordinator's `get_connection(db_path: str)` takes a required path. Keep that signature — just delegate.

- [ ] **Step 1: Replace `get_connection()` in `coordinator/db.py`**

Old (lines 135-147):
```python
def get_connection(db_path: str | Path) -> sqlite3.Connection:
    path = Path(db_path).expanduser().resolve()
    if path.parent:
        path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(path, timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        pass
    return conn
```

New:
```python
def get_connection(db_path: str | Path):
    from hunter.db_compat import get_connection as _get_connection

    # When HUNT_DB_URL is set, ignore db_path (Postgres is the target).
    # When using SQLite, ensure the parent directory exists.
    db_url = (os.environ.get("HUNT_DB_URL") or "").strip()
    if not db_url and db_path:
        path = Path(db_path).expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        return _get_connection(path)
    return _get_connection()
```

- [ ] **Step 2: Check `coordinator/service.py:262` — the lastrowid call**

```bash
sed -n '255,270p' coordinator/service.py
```

Add `RETURNING id` to whichever INSERT precedes line 262, same pattern as Tasks 5-6.

- [ ] **Step 3: Run coordinator tests**

```bash
pytest tests/test_component4_cli.py -v
```
Expected: same pass/fail as before

- [ ] **Step 4: Commit**

```bash
git add coordinator/db.py
git commit -m "delegate coordinator get_connection to db_compat"
```

---

## Task 8: Create `schema/postgres_schema.sql`

**Files:**
- Create: `schema/postgres_schema.sql`

This is the canonical Postgres DDL. Used for Phase 2b server migration.

- [ ] **Step 1: Write the file**

```sql
-- Hunt Postgres Schema
-- Apply with: psql $HUNT_DB_URL -f schema/postgres_schema.sql

-- ------------------------------------------------------------------ jobs ---
CREATE TABLE IF NOT EXISTS jobs (
    id                                  SERIAL PRIMARY KEY,
    title                               TEXT NOT NULL,
    company                             TEXT,
    location                            TEXT,
    job_url                             TEXT UNIQUE NOT NULL,
    apply_url                           TEXT,
    description                         TEXT,
    source                              TEXT,
    date_posted                         TEXT,
    is_remote                           BOOLEAN,
    status                              TEXT DEFAULT 'new',
    date_scraped                        TEXT DEFAULT CURRENT_TIMESTAMP,
    level                               TEXT,
    priority                            BOOLEAN DEFAULT FALSE,
    category                            TEXT,
    apply_type                          TEXT,
    auto_apply_eligible                 BOOLEAN,
    enrichment_status                   TEXT,
    enrichment_attempts                 INTEGER DEFAULT 0,
    enriched_at                         TEXT,
    last_enrichment_error               TEXT,
    apply_host                          TEXT,
    ats_type                            TEXT,
    last_enrichment_started_at          TEXT,
    next_enrichment_retry_at            TEXT,
    last_artifact_dir                   TEXT,
    last_artifact_screenshot_path       TEXT,
    last_artifact_html_path             TEXT,
    last_artifact_text_path             TEXT,
    latest_resume_job_description_path  TEXT,
    latest_resume_flags                 TEXT,
    selected_resume_version_id          TEXT,
    selected_resume_pdf_path            TEXT,
    selected_resume_tex_path            TEXT,
    selected_resume_selected_at         TEXT,
    selected_resume_ready_for_c3        BOOLEAN,
    resume_status                       TEXT,
    latest_resume_attempt_id            INTEGER,
    latest_resume_version_id            TEXT,
    latest_resume_pdf_path              TEXT,
    latest_resume_tex_path              TEXT,
    latest_resume_keywords_path         TEXT,
    latest_resume_family                TEXT,
    latest_resume_job_level             TEXT,
    latest_resume_model                 TEXT,
    latest_resume_generated_at          TEXT,
    latest_resume_fallback_used         BOOLEAN,
    latest_resume_jd_usable             INTEGER,
    latest_resume_jd_usable_reason      TEXT,
    latest_resume_structured_output_path TEXT,
    notes                               TEXT,
    operator_tags                       TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_enrichment_status ON jobs(enrichment_status);
CREATE INDEX IF NOT EXISTS idx_jobs_source_status ON jobs(source, enrichment_status);
CREATE INDEX IF NOT EXISTS idx_jobs_job_url ON jobs(job_url);

-- --------------------------------------------------------- runtime_state ---
CREATE TABLE IF NOT EXISTS runtime_state (
    key         TEXT PRIMARY KEY,
    value       TEXT,
    updated_at  TEXT DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------- component_settings ---
CREATE TABLE IF NOT EXISTS component_settings (
    component   TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT,
    value_type  TEXT NOT NULL DEFAULT 'string',
    secret      BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by  TEXT,
    PRIMARY KEY (component, key)
);

-- ---------------------------------------------------- linkedin_accounts ---
CREATE TABLE IF NOT EXISTS linkedin_accounts (
    id                  SERIAL PRIMARY KEY,
    username            TEXT NOT NULL UNIQUE,
    password_encrypted  TEXT,
    display_name        TEXT,
    active              BOOLEAN NOT NULL DEFAULT TRUE,
    auth_state          TEXT NOT NULL DEFAULT 'unknown',
    last_auth_check     TEXT,
    last_auth_error     TEXT,
    created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------- resume_attempts (C2) ---
CREATE TABLE IF NOT EXISTS resume_attempts (
    id                      SERIAL PRIMARY KEY,
    job_id                  INTEGER REFERENCES jobs(id),
    attempt_type            TEXT,
    status                  TEXT,
    latest_result_kind      TEXT,
    role_family             TEXT,
    job_level               TEXT,
    base_resume_name        TEXT,
    source_resume_type      TEXT,
    source_resume_path      TEXT,
    fallback_used           BOOLEAN,
    model_backend           TEXT,
    model_name              TEXT,
    prompt_version          TEXT,
    concern_flags           TEXT,
    job_description_path    TEXT,
    keywords_path           TEXT,
    structured_output_path  TEXT,
    tex_path                TEXT,
    pdf_path                TEXT,
    compile_log_path        TEXT,
    metadata_path           TEXT,
    jd_usable               INTEGER,
    jd_usable_reason        TEXT,
    job_description_hash    TEXT,
    created_at              TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_resume_attempts_job_id ON resume_attempts(job_id);

-- ---------------------------------------------------- resume_versions (C2) ---
CREATE TABLE IF NOT EXISTS resume_versions (
    id                      SERIAL PRIMARY KEY,
    job_id                  INTEGER REFERENCES jobs(id),
    resume_attempt_id       INTEGER NOT NULL REFERENCES resume_attempts(id),
    source_type             TEXT,
    label                   TEXT,
    pdf_path                TEXT,
    tex_path                TEXT NOT NULL,
    content_hash            TEXT NOT NULL,
    is_latest_generated     BOOLEAN DEFAULT FALSE,
    is_latest_useful        BOOLEAN DEFAULT FALSE,
    is_selected_for_c3      BOOLEAN DEFAULT FALSE,
    created_at              TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_resume_versions_job_id ON resume_versions(job_id);

-- ----------------------------------------------- orchestration_runs (C4) ---
CREATE TABLE IF NOT EXISTS orchestration_runs (
    id                          TEXT PRIMARY KEY,
    job_id                      INTEGER NOT NULL REFERENCES jobs(id),
    status                      TEXT NOT NULL,
    source_runtime              TEXT NOT NULL,
    browser_lane                TEXT,
    job_source                  TEXT,
    job_title                   TEXT,
    company                     TEXT,
    selected_resume_version_id  TEXT,
    selected_resume_pdf_path    TEXT,
    selected_resume_tex_path    TEXT,
    apply_url                   TEXT,
    ats_type                    TEXT,
    apply_context_path          TEXT,
    c3_apply_context_path       TEXT,
    fill_result_path            TEXT,
    browser_summary_path        TEXT,
    decision_path               TEXT,
    final_status_path           TEXT,
    manual_review_required      BOOLEAN NOT NULL DEFAULT FALSE,
    manual_review_reason        TEXT,
    manual_review_flags_json    TEXT DEFAULT '[]',
    submit_allowed              BOOLEAN NOT NULL DEFAULT FALSE,
    submit_approval_id          TEXT,
    started_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at                TEXT
);

CREATE INDEX IF NOT EXISTS idx_orchestration_runs_job_status
    ON orchestration_runs(job_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_orchestration_runs_status_started
    ON orchestration_runs(status, started_at DESC);

-- -------------------------------------------- orchestration_events (C4) ---
CREATE TABLE IF NOT EXISTS orchestration_events (
    id                      SERIAL PRIMARY KEY,
    orchestration_run_id    TEXT NOT NULL REFERENCES orchestration_runs(id),
    event_type              TEXT NOT NULL,
    step_name               TEXT NOT NULL,
    payload_json            TEXT,
    payload_path            TEXT,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orchestration_events_run_created
    ON orchestration_events(orchestration_run_id, created_at ASC, id ASC);

-- ---------------------------------------------- submit_approvals (C4) ---
CREATE TABLE IF NOT EXISTS submit_approvals (
    id                      TEXT PRIMARY KEY,
    job_id                  INTEGER NOT NULL REFERENCES jobs(id),
    orchestration_run_id    TEXT NOT NULL REFERENCES orchestration_runs(id),
    approval_mode           TEXT NOT NULL,
    approved_by             TEXT NOT NULL,
    decision                TEXT NOT NULL,
    reason                  TEXT,
    artifact_path           TEXT,
    created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_submit_approvals_run_created
    ON submit_approvals(orchestration_run_id, created_at DESC);
```

- [ ] **Step 2: Validate SQL syntax**

```bash
python -c "
import re, sys
sql = open('schema/postgres_schema.sql').read()
# Basic sanity: count balanced CREATE TABLE / semicolons
tables = len(re.findall(r'CREATE TABLE', sql))
print(f'Tables defined: {tables}')
assert tables == 8, f'Expected 8, got {tables}'
print('ok')
"
```
Expected: `Tables defined: 8` then `ok`

- [ ] **Step 3: Commit**

```bash
git add schema/postgres_schema.sql
git commit -m "add postgres schema DDL for all 8 tables"
```

---

## Task 9: Write `tests/test_db_compat.py`

**Files:**
- Create: `tests/test_db_compat.py`

- [ ] **Step 1: Write the test file**

```python
"""Tests for the db_compat connection factory (SQLite path only in CI)."""

import os
import sqlite3
import tempfile
import pytest


@pytest.fixture(autouse=True)
def clear_pg_url(monkeypatch):
    """Ensure HUNT_DB_URL is absent so all tests use the SQLite path."""
    monkeypatch.delenv("HUNT_DB_URL", raising=False)


@pytest.fixture
def tmp_db(tmp_path, monkeypatch):
    db_file = tmp_path / "compat_test.db"
    monkeypatch.setenv("HUNT_DB_PATH", str(db_file))
    from hunter import db_compat

    conn = db_compat.get_connection()
    conn.execute("CREATE TABLE test_tbl (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)")
    conn.commit()
    yield conn
    conn.close()


def test_returns_sqlite_connection_when_no_db_url(tmp_db):
    assert isinstance(tmp_db, sqlite3.Connection)


def test_execute_returns_rows(tmp_db):
    tmp_db.execute("INSERT INTO test_tbl (val) VALUES (?)", ("hello",))
    tmp_db.commit()
    rows = tmp_db.execute("SELECT val FROM test_tbl").fetchall()
    assert len(rows) == 1
    assert rows[0]["val"] == "hello"


def test_row_factory_dict_access(tmp_db):
    tmp_db.execute("INSERT INTO test_tbl (val) VALUES (?)", ("world",))
    tmp_db.commit()
    row = tmp_db.execute("SELECT * FROM test_tbl WHERE val = ?", ("world",)).fetchone()
    assert row["val"] == "world"
    assert "id" in dict(row)


def test_returning_id_captured(tmp_db):
    cur = tmp_db.execute(
        "INSERT INTO test_tbl (val) VALUES (?) RETURNING id", ("ret_test",)
    )
    tmp_db.commit()
    assert cur.lastrowid is not None
    assert isinstance(cur.lastrowid, int)


def test_context_manager_commits(tmp_path, monkeypatch):
    db_file = tmp_path / "ctx_test.db"
    monkeypatch.setenv("HUNT_DB_PATH", str(db_file))
    from hunter import db_compat

    with db_compat.get_connection() as conn:
        conn.execute(
            "CREATE TABLE ctx_tbl (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)"
        )
        conn.execute("INSERT INTO ctx_tbl (val) VALUES (?)", ("auto_commit",))

    # Verify commit happened by opening a fresh connection
    conn2 = db_compat.get_connection()
    rows = conn2.execute("SELECT * FROM ctx_tbl").fetchall()
    conn2.close()
    assert len(rows) == 1
    assert rows[0]["val"] == "auto_commit"


def test_pg_sql_translation():
    from hunter.db_compat import _pg_sql

    assert _pg_sql("SELECT * FROM t WHERE id = ?") == "SELECT * FROM t WHERE id = %s"
    assert _pg_sql("PRAGMA journal_mode = WAL") == "SELECT 1"
    assert "BEGIN" in _pg_sql("BEGIN IMMEDIATE")
    assert "IMMEDIATE" not in _pg_sql("BEGIN IMMEDIATE")
```

- [ ] **Step 2: Run tests**

```bash
pytest tests/test_db_compat.py -v
```
Expected: 6 PASS

- [ ] **Step 3: Commit**

```bash
git add tests/test_db_compat.py
git commit -m "add db_compat unit tests"
```

---

## Task 10: Final integration smoke test

- [ ] **Step 1: Run all affected test suites together**

```bash
pytest tests/test_db_compat.py tests/test_new_tables.py tests/test_stage1.py tests/test_stage2.py tests/test_component2_stage1.py tests/test_component4_cli.py -v 2>&1 | tail -30
```
Expected: all tests that passed before still pass; new tests pass.

- [ ] **Step 2: Verify `init_db()` still works end-to-end with a fresh temp DB**

```bash
python -c "
import os, tempfile, pathlib
tmp = tempfile.mktemp(suffix='.db')
os.environ['HUNT_DB_PATH'] = tmp
from hunter.db import init_db, get_connection
init_db(maintenance=False)
conn = get_connection()
tables = [r[0] for r in conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\").fetchall()]
conn.close()
expected = {'jobs','runtime_state','component_settings','linkedin_accounts'}
assert expected.issubset(set(tables)), f'Missing tables: {expected - set(tables)}'
print('All tables present:', sorted(tables))
pathlib.Path(tmp).unlink(missing_ok=True)
"
```
Expected: prints all table names including `component_settings` and `linkedin_accounts`.

- [ ] **Step 3: Final commit if anything was missed**

```bash
git status
```

---

## Out of Scope (next plans)

- Phase 2b: server2 data migration (`playbooks/tasks/hunt_migration.yml`)
- Phase 3: Component service APIs (C1 FastAPI, C2 FastAPI, C4 FastAPI)
- Phase 4: C0 gateway wiring (`/api/*` routes)
- Phase 5: Dockerfiles + compose
- Phase 6: Ansible v2 (Stages 6-9)
- Phase 7: C2 v1.0 (LLM tailoring + candidate profile wiring)
- Phase 8: C3 hardening
- Phase 9: C4 tests + live C3 bridge
