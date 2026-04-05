import argparse
import sqlite3
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = REPO_ROOT / "hunt.db"


def main():
    parser = argparse.ArgumentParser(description="Verify Stage 2 enrichment fields for one LinkedIn job.")
    parser.add_argument("--job-id", type=int, required=True, help="LinkedIn job id to verify.")
    parser.add_argument(
        "--expect-type",
        choices=["easy_apply", "external_apply"],
        help="Optional expected apply_type for the row.",
    )
    parser.add_argument(
        "--expect-status",
        choices=["done", "done_verified", "blocked", "blocked_verified", "failed"],
        help="Optional expected enrichment_status for the row.",
    )
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
            SELECT id, source, title, company, job_url, apply_url, description,
                   apply_type, auto_apply_eligible, enrichment_status,
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

    failures = []
    actual_status = row["enrichment_status"]
    expected_success_statuses = {"done", "done_verified"}
    if args.expect_status:
        if actual_status != args.expect_status:
            failures.append(
                f"expected enrichment_status={args.expect_status!r}, got {actual_status!r}"
            )
    elif actual_status not in expected_success_statuses:
        failures.append(f"expected enrichment_status in {sorted(expected_success_statuses)!r}, got {actual_status!r}")

    blocked_statuses = {"blocked", "blocked_verified"}
    success_like = actual_status in expected_success_statuses
    blocked_like = actual_status in blocked_statuses

    if success_like:
        if row["apply_type"] == "external_apply" and (not row["description"] or not str(row["description"]).strip()):
            failures.append("description is empty")
        if not row["enriched_at"]:
            failures.append("enriched_at is empty")
        if row["last_enrichment_error"]:
            failures.append(f"last_enrichment_error is set: {row['last_enrichment_error']}")
    elif blocked_like:
        if not row["last_enrichment_error"]:
            failures.append("blocked row should keep last_enrichment_error")
        if row["enriched_at"]:
            failures.append("blocked row should not set enriched_at")
    else:
        if not row["last_enrichment_error"]:
            failures.append("failed row should keep last_enrichment_error")
    if args.expect_type and row["apply_type"] != args.expect_type:
        failures.append(f"expected apply_type={args.expect_type!r}, got {row['apply_type']!r}")

    if row["apply_type"] == "external_apply":
        if row["auto_apply_eligible"] != 1:
            failures.append("external_apply row must have auto_apply_eligible=1")
        if not row["apply_url"]:
            failures.append("external_apply row must have apply_url")
        if not row["apply_host"]:
            failures.append("external_apply row must have apply_host")
    elif row["apply_type"] == "easy_apply":
        if row["auto_apply_eligible"] != 0:
            failures.append("easy_apply row must have auto_apply_eligible=0")
        if row["apply_url"]:
            failures.append("easy_apply row should not keep an external apply_url")
    else:
        failures.append(f"unexpected apply_type: {row['apply_type']!r}")

    if failures:
        print("Stage 2 verification: FAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("Stage 2 verification: PASS")
    print(f"id: {row['id']}")
    print(f"company: {row['company']}")
    print(f"title: {row['title']}")
    print(f"enrichment_status: {row['enrichment_status']}")
    print(f"apply_type: {row['apply_type']}")
    print(f"auto_apply_eligible: {row['auto_apply_eligible']}")
    print(f"apply_url: {row['apply_url']}")
    print(f"apply_host: {row['apply_host']}")
    print(f"ats_type: {row['ats_type']}")
    print(f"enriched_at: {row['enriched_at']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
