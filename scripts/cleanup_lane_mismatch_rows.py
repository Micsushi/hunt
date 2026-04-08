#!/usr/bin/env python3
"""
Preview or delete jobs whose title does not match their discovery search lane (category).

Applies to all sources (LinkedIn, Indeed, …) that store ``category`` from SEARCH_TERMS lanes.
"""
import argparse
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)

from hunter.db import get_connection, init_db  # noqa: E402
from hunter.search_lanes import title_matches_search_lane  # noqa: E402


def parse_args():
    parser = argparse.ArgumentParser(
        description="Preview or delete job rows whose title does not match the stored search lane (engineering/product/data)."
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Delete the matched rows. Without this flag, run in preview mode only.",
    )
    parser.add_argument(
        "--include-non-new",
        action="store_true",
        help="Also consider rows whose application status is not 'new'.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Optional max number of rows to inspect from newest to oldest.",
    )
    parser.add_argument(
        "--source",
        default="all",
        choices=["linkedin", "indeed", "all"],
        help="Limit to one board (default: all sources).",
    )
    return parser.parse_args()


def find_lane_mismatch_rows(*, include_non_new=False, limit=None, source_filter=None):
    conn = get_connection()
    try:
        cursor = conn.cursor()
        params = []
        status_sql = ""
        if not include_non_new:
            status_sql = " AND coalesce(status, 'new') = 'new'"

        source_sql = ""
        if source_filter and source_filter != "all":
            source_sql = " AND source = ?"
            params.append(source_filter)

        limit_sql = ""
        if limit is not None:
            limit_sql = " LIMIT ?"
            params.append(limit)

        rows = cursor.execute(
            f"""
            SELECT id, source, company, title, category, enrichment_status, status, date_scraped
            FROM jobs
            WHERE category IS NOT NULL
              AND trim(category) != ''
              {status_sql}
              {source_sql}
            ORDER BY date_scraped DESC, id DESC
            {limit_sql}
            """,
            tuple(params),
        ).fetchall()

        return [
            dict(row)
            for row in rows
            if not title_matches_search_lane(row["title"], row["category"])
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
    src = None if args.source == "all" else args.source
    rows = find_lane_mismatch_rows(
        include_non_new=args.include_non_new,
        limit=args.limit,
        source_filter=src,
    )

    if not rows:
        print("No rows failed the search-lane title check.")
        return

    print(f"Matched {len(rows)} row(s) (title vs lane):")
    for row in rows[:20]:
        print(
            f"id={row['id']} | source={row.get('source')} | company={row.get('company')} | title={row.get('title')} "
            f"| lane={row.get('category')} | enrichment={row.get('enrichment_status')} | status={row.get('status')}"
        )
    if len(rows) > 20:
        print(f"... plus {len(rows) - 20} more row(s)")

    if not args.apply:
        print("Preview only. Re-run with --apply to delete these rows.")
        return

    deleted = delete_rows([row["id"] for row in rows])
    print(f"Deleted {deleted} row(s).")


if __name__ == "__main__":
    main()
