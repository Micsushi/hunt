"""Shared DB connection factory for all Hunt components.

SQLite is used when HUNT_DB_URL is absent (local dev).
Postgres (psycopg2) is used when HUNT_DB_URL is set (production).

All existing SQL uses ? placeholders (SQLite style).
The Postgres wrapper translates ? -> %s transparently.
"""

from __future__ import annotations

import os
import re
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
    if db_path:
        path = str(db_path)
    else:
        env_path = (os.getenv("HUNT_DB_PATH") or "").strip()
        if env_path:
            path = env_path
        else:
            from hunter.config import DB_PATH  # last-resort fallback
            path = DB_PATH
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
    """Translate SQLite dialect -> Postgres dialect."""
    pragma_table = re.match(
        r"^\s*PRAGMA\s+table_info\((?P<table>[A-Za-z_][A-Za-z0-9_]*)\)\s*$",
        query,
        flags=re.IGNORECASE,
    )
    if pragma_table:
        return (
            "SELECT ordinal_position - 1 AS cid, column_name AS name, "
            "data_type AS type, CASE WHEN is_nullable = 'NO' THEN 1 ELSE 0 END AS notnull, "
            "column_default AS dflt_value, 0 AS pk "
            "FROM information_schema.columns "
            "WHERE table_schema = current_schema() AND table_name = %s "
            "ORDER BY ordinal_position"
        )
    # SQLite-only PRAGMA lines become no-ops
    if query.strip().upper().startswith("PRAGMA"):
        return "SELECT 1"
    query = _translate_sqlite_functions(query)
    # Placeholder style
    query = query.replace("?", "%s")
    # SQLite autoincrement primary keys -> Postgres sequence-backed primary keys
    query = re.sub(
        r"\b(\w+)\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b",
        r"\1 SERIAL PRIMARY KEY",
        query,
        flags=re.IGNORECASE,
    )
    # SQLite BEGIN IMMEDIATE -> standard Postgres BEGIN
    query = query.replace("BEGIN IMMEDIATE", "BEGIN")
    return query


def _translate_sqlite_functions(query: str) -> str:
    """Translate SQLite scalar functions used by Hunt into Postgres equivalents."""
    query = re.sub(
        r"\bDATE\(\s*'now'\s*,\s*\?\s*\|\|\s*' days'\s*\)",
        r"(CURRENT_DATE + (? || ' days')::interval)",
        query,
        flags=re.IGNORECASE,
    )
    query = re.sub(
        r"\bSUBSTR\(\s*COALESCE\(\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*,\s*''\s*\)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)",
        r"substring(COALESCE(\1,'') from \2 for \3)",
        query,
        flags=re.IGNORECASE,
    )
    query = re.sub(
        r"\bSUBSTR\(\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)",
        r"substring(\1 from \2 for \3)",
        query,
        flags=re.IGNORECASE,
    )
    query = re.sub(
        r"\binstr\(\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*,\s*('[^']*'|\"[^\"]*\"|[A-Za-z_][A-Za-z0-9_\.]*)\s*\)",
        r"strpos(\1, \2)",
        query,
        flags=re.IGNORECASE,
    )
    query = re.sub(
        r"\bdatetime\(\s*'now'\s*,\s*\?\s*\)",
        r"(CURRENT_TIMESTAMP + ?::interval)",
        query,
        flags=re.IGNORECASE,
    )
    query = re.sub(
        r"\bdatetime\(\s*coalesce\(\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*,\s*CURRENT_TIMESTAMP\s*\)\s*\)",
        r"(coalesce(NULLIF(\1, '')::timestamp, CURRENT_TIMESTAMP))",
        query,
        flags=re.IGNORECASE,
    )
    query = re.sub(
        r"\bdatetime\(\s*coalesce\((.*?)\)\s*\)",
        r"(NULLIF(coalesce(\1), '')::timestamp)",
        query,
        flags=re.IGNORECASE | re.DOTALL,
    )
    query = re.sub(
        r"\bdatetime\(\s*(CURRENT_TIMESTAMP)\s*\)",
        r"(\1)::timestamp",
        query,
        flags=re.IGNORECASE,
    )
    query = re.sub(
        r"\bdatetime\(\s*([A-Za-z_][A-Za-z0-9_\.]*)\s*\)",
        r"(NULLIF(\1, '')::timestamp)",
        query,
        flags=re.IGNORECASE,
    )
    query = re.sub(
        r"\b([A-Za-z_][A-Za-z0-9_\.]*_at)\s*(<=|>=|<|>)\s*CURRENT_TIMESTAMP\b",
        r"NULLIF(\1, '')::timestamp \2 CURRENT_TIMESTAMP",
        query,
        flags=re.IGNORECASE,
    )
    return query


class _PgConnCompat:
    """Makes a psycopg2 connection behave like sqlite3 for Hunt's usage patterns."""

    def __init__(self, conn):
        self._conn = conn

    def cursor(self) -> "_PgCursorCompat":
        import psycopg2.extras

        return _PgCursorCompat(
            self._conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor),
            self._conn,
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

    def __init__(self, cur, conn):
        self._cur = cur
        self._conn = conn  # raw psycopg2 connection for lastval() calls
        self.lastrowid: int | None = None

    def execute(self, query: str, params=()) -> "_PgCursorCompat":
        pg_query = _pg_sql(query)
        if not params:
            table_match = re.match(
                r"^\s*PRAGMA\s+table_info\((?P<table>[A-Za-z_][A-Za-z0-9_]*)\)\s*$",
                query,
                flags=re.IGNORECASE,
            )
            if table_match:
                params = (table_match.group("table"),)
        self._cur.execute(pg_query, params if params else None)
        # Mirror SQLite's lastrowid for INSERT statements using sequences.
        # Use a SAVEPOINT so a lastval() failure (table has no sequence, e.g. TEXT PK)
        # only rolls back the sub-operation and does not abort the outer transaction.
        if pg_query.strip().upper().startswith("INSERT"):
            sp_cur = self._conn.cursor()
            try:
                sp_cur.execute("SAVEPOINT _lastval")
                sp_cur.execute("SELECT lastval()")
                row = sp_cur.fetchone()
                self.lastrowid = row[0] if row else None
                sp_cur.execute("RELEASE SAVEPOINT _lastval")
            except Exception:
                try:
                    sp_cur.execute("ROLLBACK TO SAVEPOINT _lastval")
                except Exception:
                    pass
                self.lastrowid = None
            finally:
                sp_cur.close()
        return self

    def executemany(self, query: str, param_list) -> "_PgCursorCompat":
        pg_query = _pg_sql(query)
        self._cur.executemany(pg_query, param_list)
        return self

    def fetchone(self):
        row = self._cur.fetchone()
        return _PgRowCompat(row) if row else None

    def fetchall(self):
        return [_PgRowCompat(r) for r in self._cur.fetchall()]

    def fetchmany(self, size: int):
        return [_PgRowCompat(r) for r in self._cur.fetchmany(size)]

    def __iter__(self):
        for row in self._cur:
            yield _PgRowCompat(row)

    @property
    def rowcount(self) -> int:
        return self._cur.rowcount


class _PgRowCompat(dict):
    """Dict row that also supports sqlite3.Row-style numeric indexing."""

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self.values())[key]
        return super().__getitem__(key)
