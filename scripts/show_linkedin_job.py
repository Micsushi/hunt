import argparse
import sqlite3
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "hunt.db"


def main():
    parser = argparse.ArgumentParser(description="Show the key enrichment fields for one LinkedIn job.")
    parser.add_argument("--job-id", type=int, required=True, help="LinkedIn job id to inspect.")
    parser.add_argument(
        "--db",
        default=str(DEFAULT_DB_PATH),
        help=f"Path to SQLite DB (default: {DEFAULT_DB_PATH})",
    )
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """
            SELECT id, title, company, source, job_url, apply_url, description,
                   status, apply_type, auto_apply_eligible, enrichment_status,
                   enrichment_attempts, enriched_at, last_enrichment_error,
                   apply_host, ats_type
            FROM jobs
            WHERE id = ?
            """,
            (args.job_id,),
        ).fetchone()
    finally:
        conn.close()

    if not row:
        print(f"Job id={args.job_id} not found.")
        return 1

    if row["source"] != "linkedin":
        print(f"Job id={args.job_id} is source={row['source']}, not linkedin.")
        return 1

    for key in row.keys():
        value = row[key]
        if key == "description" and value:
            preview = value[:300].replace("\n", " ")
            suffix = "..." if len(value) > 300 else ""
            print(f"{key}: {preview}{suffix}")
        else:
            print(f"{key}: {value}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
