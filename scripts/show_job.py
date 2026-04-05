import argparse
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SCRAPER_DIR = REPO_ROOT / "scraper"
sys.path.insert(0, str(SCRAPER_DIR))

from db import get_job_by_id  # noqa: E402


def main():
    parser = argparse.ArgumentParser(description="Show the key fields for one job.")
    parser.add_argument("job_id", type=int, help="Job id to inspect.")
    parser.add_argument(
        "--full-description",
        action="store_true",
        help="Print the full saved description instead of a preview.",
    )
    args = parser.parse_args()

    row = get_job_by_id(args.job_id)
    if not row:
        print(f"Job id={args.job_id} not found.")
        return 1

    for key, value in row.items():
        if key == "description" and value and not args.full_description:
            preview = str(value)[:300].replace("\n", " ")
            suffix = "..." if len(str(value)) > 300 else ""
            print(f"{key}: {preview}{suffix}")
        else:
            print(f"{key}: {value}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
