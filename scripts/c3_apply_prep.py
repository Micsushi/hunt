#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from coordinator.apply_prep import (  # noqa: E402
    ApplyPrepNotReadyError,
    build_apply_prep_payload,
)


def main():
    parser = argparse.ArgumentParser(
        description="Legacy helper: build the C3-only camelCase apply payload for one job."
    )
    parser.add_argument("job_id", type=int)
    parser.add_argument(
        "--embed-resume-data",
        action="store_true",
        help="Embed the selected resume PDF as a data URL when the file exists.",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Optional path to write the JSON payload to disk. If omitted, the shared apply-prep runtime path is used.",
    )
    parser.add_argument(
        "--allow-not-ready",
        action="store_true",
        help="Build the payload even when the job does not meet the documented ready-to-apply predicate.",
    )
    args = parser.parse_args()

    try:
        payload = build_apply_prep_payload(
            args.job_id,
            embed_resume_data=args.embed_resume_data,
            require_ready=not args.allow_not_ready,
            output_path=Path(args.output) if args.output else None,
        )
    except ApplyPrepNotReadyError as error:
        raise SystemExit(
            f"Job {error.job_id} is not ready for apply-prep: {error.reason}"
        ) from error

    rendered = json.dumps(payload, indent=2)
    if args.output:
        Path(args.output).write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
