import argparse
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from hunter import db  # noqa: E402


def main():
    parser = argparse.ArgumentParser(
        description="Requeue historical LinkedIn rows that failed before newer Stage 2 metadata/classification logic existed."
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="Optional max number of stale failed rows to requeue.",
    )
    args = parser.parse_args()

    db.init_db()
    job_ids = db.requeue_linkedin_rows_for_refresh(limit=args.limit)

    if not job_ids:
        print("No historical LinkedIn refresh candidates found.")
        return 0

    print(f"Requeued {len(job_ids)} LinkedIn row(s) to pending:")
    for job_id in job_ids:
        print(f"- {job_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
