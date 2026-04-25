"""Migrate Hunt SQLite database to Postgres.

Usage:
    python scripts/migrate_sqlite_to_postgres.py \
        --sqlite hunt.db \
        --postgres postgresql://hunt:password@localhost:5432/hunt

Steps:
    1. Reads every table from SQLite.
    2. Inserts rows into Postgres preserving original IDs.
    3. Resets Postgres SERIAL sequences so new rows get correct IDs.
    4. Prints row counts for each table to confirm parity.

Run this AFTER applying schema/postgres_schema.sql to the target Postgres DB.
Run this BEFORE pointing any service at HUNT_DB_URL.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

# Tables in dependency order (parents before children for FK constraints).
# Tables with TEXT primary keys (orchestration_runs, submit_approvals) have no sequence.
TABLES_IN_ORDER = [
    "jobs",
    "runtime_state",
    "component_settings",
    "linkedin_accounts",
    "resume_attempts",
    "resume_versions",
    "orchestration_runs",
    "orchestration_events",
    "submit_approvals",
]

# Tables that use SERIAL (integer sequence) primary keys.
SERIAL_TABLES = {
    "jobs",
    "linkedin_accounts",
    "resume_attempts",
    "resume_versions",
    "orchestration_events",
}

BOOLEAN_COLUMNS = {
    "jobs": {
        "is_remote",
        "priority",
        "auto_apply_eligible",
        "selected_resume_ready_for_c3",
        "latest_resume_fallback_used",
    },
    "component_settings": {"secret"},
    "linkedin_accounts": {"active"},
    "resume_attempts": {"fallback_used"},
    "resume_versions": {
        "is_latest_generated",
        "is_latest_useful",
        "is_selected_for_c3",
    },
    "orchestration_runs": {
        "manual_review_required",
        "submit_allowed",
    },
}


def migrate(sqlite_path: str, postgres_url: str, *, dry_run: bool = False) -> None:
    import psycopg2
    import psycopg2.extras

    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row

    pg_conn = psycopg2.connect(postgres_url)
    pg_conn.autocommit = False

    try:
        for table in TABLES_IN_ORDER:
            _migrate_table(sqlite_conn, pg_conn, table, dry_run=dry_run)

        if not dry_run:
            pg_conn.commit()
            _reset_sequences(pg_conn)
            pg_conn.commit()
            print("\nMigration complete.")
        else:
            pg_conn.rollback()
            print("\nDry run complete — no data written.")

    except Exception:
        pg_conn.rollback()
        raise
    finally:
        sqlite_conn.close()
        pg_conn.close()


def _migrate_table(
    sqlite_conn: sqlite3.Connection,
    pg_conn,
    table: str,
    *,
    dry_run: bool,
) -> None:
    try:
        rows = sqlite_conn.execute(f"SELECT * FROM {table}").fetchall()
    except sqlite3.OperationalError as exc:
        if "no such table" in str(exc).lower():
            print(f"  {table}: missing in SQLite source (skipped)")
            return
        raise
    if not rows:
        print(f"  {table}: 0 rows (skipped)")
        return

    columns = list(rows[0].keys())
    col_list = ", ".join(columns)
    records = [_coerce_record(table, columns, row) for row in rows]

    if dry_run:
        print(f"  {table}: {len(records)} rows (dry run)")
        return

    cur = pg_conn.cursor()
    import psycopg2.extras

    psycopg2.extras.execute_values(
        cur,
        f"INSERT INTO {table} ({col_list}) VALUES %s ON CONFLICT DO NOTHING",
        records,
    )

    print(f"  {table}: {len(records)} rows migrated")


def _coerce_record(table: str, columns: list[str], row: sqlite3.Row) -> tuple:
    bool_columns = BOOLEAN_COLUMNS.get(table, set())
    values = []
    for col in columns:
        value = row[col]
        if col in bool_columns and value is not None:
            value = _coerce_bool(value)
        values.append(value)
    return tuple(values)


def _coerce_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "t", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "f", "no", "n", "off", ""}:
            return False
    return value


def _reset_sequences(pg_conn) -> None:
    """Advance each SERIAL sequence past the highest existing ID."""
    cur = pg_conn.cursor()
    for table in SERIAL_TABLES:
        cur.execute(f"SELECT MAX(id) FROM {table}")
        row = cur.fetchone()
        max_id = row[0] if row and row[0] is not None else 0
        if max_id > 0:
            cur.execute(
                f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), %s)",
                (max_id,),
            )
            print(f"  sequence {table}.id reset to {max_id}")


def _validate(sqlite_path: str, postgres_url: str) -> None:
    """Print row counts for each table in both databases for comparison."""
    import psycopg2

    sqlite_conn = sqlite3.connect(sqlite_path)
    pg_conn = psycopg2.connect(postgres_url)

    print(f"\n{'Table':<30} {'SQLite':>10} {'Postgres':>10} {'Match':>6}")
    print("-" * 60)
    all_match = True
    for table in TABLES_IN_ORDER:
        try:
            sq = sqlite_conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        except sqlite3.OperationalError as exc:
            if "no such table" in str(exc).lower():
                sq = 0
            else:
                sq = "N/A"
        except Exception:
            sq = "N/A"
        try:
            cur = pg_conn.cursor()
            cur.execute(f"SELECT COUNT(*) FROM {table}")
            pg = cur.fetchone()[0]
        except Exception:
            pg = "N/A"
        match = "OK" if sq == pg else "MISMATCH"
        if match != "OK":
            all_match = False
        print(f"  {table:<28} {str(sq):>10} {str(pg):>10} {match:>6}")

    sqlite_conn.close()
    pg_conn.close()

    if not all_match:
        sys.exit(1)
    print("\nAll counts match.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate Hunt SQLite -> Postgres")
    parser.add_argument("--sqlite", required=True, help="Path to SQLite hunt.db")
    parser.add_argument("--postgres", required=True, help="Postgres connection URL")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Read SQLite and print counts without writing to Postgres",
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Compare row counts between SQLite and Postgres (run after migration)",
    )
    args = parser.parse_args()

    if args.validate:
        _validate(args.sqlite, args.postgres)
    else:
        migrate(args.sqlite, args.postgres, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
