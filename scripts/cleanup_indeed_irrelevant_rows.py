#!/usr/bin/env python3
import argparse
import os
import sys


REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRAPER_DIR = os.path.join(REPO_ROOT, "scraper")
sys.path.insert(0, SCRAPER_DIR)

from db import get_connection, init_db  # noqa: E402
from indeed_filters import matches_indeed_category  # noqa: E402


def parse_args():
    parser = argparse.ArgumentParser(
        description="Preview or delete currently stored Indeed rows that do not match the intended target categories."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Delete the matched rows. Without this flag, run in preview mode only.",
    )
    parser.add_argument(
        "--include-non-new",
        action="store_true",
        help="Also consider Indeed rows whose application status is not 'new'.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional max number of rows to inspect from newest to oldest.",
    )
    return parser.parse_args()


def find_irrelevant_indeed_rows(*, include_non_new=False, limit=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        params = []
        status_sql = ""
        if not include_non_new:
            status_sql = " AND coalesce(status, 'new') = 'new'"

        limit_sql = ""
        if limit is not None:
            limit_sql = " LIMIT ?"
            params.append(limit)

        rows = cursor.execute(
            f"""
            SELECT id, company, title, category, enrichment_status, status, date_scraped
            FROM jobs
            WHERE source = 'indeed'
              AND category IS NOT NULL
              AND trim(category) != ''
              {status_sql}
            ORDER BY date_scraped DESC, id DESC
            {limit_sql}
            """,
            tuple(params),
        ).fetchall()

        return [
            dict(row)
            for row in rows
            if not matches_indeed_category(row["title"], row["category"])
        ]
    finally:
        conn.close()


def delete_rows(job_ids):
    if not job_ids:
        return 0

    conn = get_connection()
    try:
        cursor = conn.cursor()
        placeholders = ", ".join(["?"] * len(job_ids))
        cursor.execute(
            f"DELETE FROM jobs WHERE id IN ({placeholders})",
            tuple(job_ids),
        )
        conn.commit()
        return cursor.rowcount
    finally:
        conn.close()


def main():
    args = parse_args()
    init_db()
    rows = find_irrelevant_indeed_rows(
        include_non_new=args.include_non_new,
        limit=args.limit,
    )

    if not rows:
        print("No irrelevant Indeed rows matched the current cleanup rule.")
        return

    print(f"Matched {len(rows)} irrelevant Indeed row(s):")
    for row in rows[:20]:
        print(
            f"id={row['id']} | company={row.get('company')} | title={row.get('title')} "
            f"| category={row.get('category')} | enrichment={row.get('enrichment_status')} | status={row.get('status')}"
        )
    if len(rows) > 20:
        print(f"... plus {len(rows) - 20} more row(s)")

    if not args.apply:
        print("Preview only. Re-run with --apply to delete these rows.")
        return

    deleted = delete_rows([row["id"] for row in rows])
    print(f"Deleted {deleted} irrelevant Indeed row(s).")


if __name__ == "__main__":
    main()
