import argparse
import sqlite3
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "hunt.db"


def main():
    parser = argparse.ArgumentParser(description="List LinkedIn jobs in the enrichment queue.")
    parser.add_argument(
        "--status",
        default="pending",
        choices=[
            "pending",
            "processing",
            "done",
            "done_verified",
            "failed",
            "blocked",
            "blocked_verified",
            "all",
        ],
        help="Enrichment status to filter by (default: pending).",
    )
    parser.add_argument("--limit", type=int, default=10, help="Max rows to print (default: 10).")
    parser.add_argument(
        "--db",
        default=str(DEFAULT_DB_PATH),
        help=f"Path to SQLite DB (default: {DEFAULT_DB_PATH})",
    )
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    try:
        if args.status == "all":
            rows = conn.execute(
                """
                SELECT id, company, title, apply_type, enrichment_status, enrichment_attempts,
                       date_scraped, last_enrichment_error
                FROM jobs
                WHERE source = 'linkedin'
                ORDER BY date_scraped DESC, id DESC
                LIMIT ?
                """,
                (args.limit,),
            ).fetchall()
        else:
            rows = conn.execute(
                """
                SELECT id, company, title, apply_type, enrichment_status, enrichment_attempts,
                       date_scraped, last_enrichment_error
                FROM jobs
                WHERE source = 'linkedin'
                  AND enrichment_status = ?
                ORDER BY date_scraped DESC, id DESC
                LIMIT ?
                """,
                (args.status, args.limit),
            ).fetchall()
    finally:
        conn.close()

    if not rows:
        print(f"No LinkedIn rows found with enrichment_status={args.status!r}.")
        return 0

    for row in rows:
        message = (
            f"id={row['id']} | company={row['company']} | title={row['title']} | "
            f"apply_type={row['apply_type']} | status={row['enrichment_status']} | "
            f"attempts={row['enrichment_attempts']} | scraped={row['date_scraped']}"
        )
        if row["last_enrichment_error"]:
            message += f" | error={row['last_enrichment_error']}"
        print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
