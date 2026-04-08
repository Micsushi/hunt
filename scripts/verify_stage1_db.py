import argparse
import sqlite3
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "hunt.db"

REQUIRED_COLUMNS = {
    "apply_type",
    "auto_apply_eligible",
    "enrichment_status",
    "enrichment_attempts",
    "enriched_at",
    "last_enrichment_error",
    "apply_host",
    "ats_type",
}

CHECK_QUERIES = {
    "linkedin_total": "SELECT COUNT(*) FROM jobs WHERE source='linkedin'",
    "linkedin_pending_unknown": """
        SELECT COUNT(*) FROM jobs
        WHERE source='linkedin'
          AND apply_type='unknown'
          AND enrichment_status='pending'
    """,
    "linkedin_mirrored_apply_url": """
        SELECT COUNT(*) FROM jobs
        WHERE source='linkedin'
          AND apply_url = job_url
          AND job_url LIKE 'https://www.linkedin.com/%'
    """,
    "linkedin_done_without_enriched_at": """
        SELECT COUNT(*) FROM jobs
        WHERE source='linkedin'
          AND enrichment_status='done'
          AND enriched_at IS NULL
    """,
    "linkedin_auto_apply_ready": """
        SELECT COUNT(*) FROM jobs
        WHERE source='linkedin'
          AND apply_type='external_apply'
          AND auto_apply_eligible = 1
    """,
    "nan_job_url": """
        SELECT COUNT(*) FROM jobs
        WHERE job_url IS NOT NULL
          AND lower(job_url) = 'nan'
    """,
    "nan_apply_url": """
        SELECT COUNT(*) FROM jobs
        WHERE apply_url IS NOT NULL
          AND lower(apply_url) = 'nan'
    """,
}


def get_column_names(cursor):
    return {row[1] for row in cursor.execute("PRAGMA table_info(jobs)")}


def collect_checks(cursor):
    return {name: cursor.execute(sql).fetchone()[0] for name, sql in CHECK_QUERIES.items()}


def evaluate_results(columns, checks):
    failures = []

    missing_columns = sorted(REQUIRED_COLUMNS - columns)
    if missing_columns:
        failures.append(f"missing required columns: {', '.join(missing_columns)}")

    if checks["linkedin_mirrored_apply_url"] != 0:
        failures.append("LinkedIn rows still exist where apply_url mirrors job_url")

    if checks["linkedin_done_without_enriched_at"] != 0:
        failures.append("LinkedIn rows are marked done without enriched_at")

    if checks["linkedin_auto_apply_ready"] != 0:
        failures.append("LinkedIn rows are marked auto-apply ready before Stage 2 enrichment")

    if checks["nan_job_url"] != 0:
        failures.append("job_url contains literal 'nan' values")

    if checks["nan_apply_url"] != 0:
        failures.append("apply_url contains literal 'nan' values")

    if checks["linkedin_total"] != checks["linkedin_pending_unknown"]:
        failures.append("not all LinkedIn rows are pending/unknown in the Stage 1 baseline")

    return failures


def main():
    parser = argparse.ArgumentParser(
        description="Verify the live hunt.db matches Stage 1 LinkedIn baseline expectations."
    )
    parser.add_argument(
        "--db",
        default=str(DEFAULT_DB_PATH),
        help=f"Path to SQLite DB (default: {DEFAULT_DB_PATH})",
    )
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"DB not found: {db_path}")
        return 1

    conn = sqlite3.connect(db_path)
    try:
        cursor = conn.cursor()
        columns = get_column_names(cursor)
        checks = collect_checks(cursor)
    finally:
        conn.close()

    print(f"DB: {db_path}")
    for name, value in checks.items():
        print(f"{name}: {value}")

    failures = evaluate_results(columns, checks)
    if failures:
        print("\nStage 1 verification: FAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("\nStage 1 verification: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
