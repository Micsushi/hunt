import argparse
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from coordinator.service import OrchestrationService  # noqa: E402
from hunter.db import get_job_by_id  # noqa: E402

DEFAULT_DB_PATH = REPO_ROOT / "hunt.db"


def build_parser():
    parser = argparse.ArgumentParser(
        description="Verify that an Easy Apply row stays excluded from the C4 automation queue."
    )
    parser.add_argument("--job-id", type=int, required=True, help="LinkedIn job id to verify.")
    parser.add_argument(
        "--db-path",
        default=str(DEFAULT_DB_PATH),
        help=f"Path to Hunt DB (default: {DEFAULT_DB_PATH})",
    )
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)

    _prev = os.environ.get("HUNT_DB_PATH")
    os.environ["HUNT_DB_PATH"] = args.db_path
    try:
        return _main_run(args)
    finally:
        if _prev is None:
            os.environ.pop("HUNT_DB_PATH", None)
        else:
            os.environ["HUNT_DB_PATH"] = _prev


def _main_run(args):
    job = get_job_by_id(args.job_id)
    if not job:
        print("Easy Apply verification: FAIL")
        print(f"- job id={args.job_id} not found")
        return 1

    failures = []
    if job.get("source") != "linkedin":
        failures.append(f"expected source='linkedin', got {job.get('source')!r}")
    if job.get("apply_type") != "easy_apply":
        failures.append(f"expected apply_type='easy_apply', got {job.get('apply_type')!r}")
    if job.get("auto_apply_eligible") != 0:
        failures.append(f"expected auto_apply_eligible=0, got {job.get('auto_apply_eligible')!r}")
    if job.get("apply_url"):
        failures.append("easy_apply row should not keep an external apply_url")
    if job.get("enrichment_status") not in {"done", "done_verified"}:
        failures.append(
            "expected enrichment_status in {'done', 'done_verified'}, "
            f"got {job.get('enrichment_status')!r}"
        )

    decision = OrchestrationService(db_path=args.db_path).get_ready_decision(args.job_id)
    if decision.ready:
        failures.append("C4 marked the job ready, but Easy Apply rows must stay excluded")
    if decision.reason != "easy_apply_excluded":
        failures.append(f"expected C4 reason='easy_apply_excluded', got {decision.reason!r}")

    if failures:
        print("Easy Apply verification: FAIL")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("Easy Apply verification: PASS")
    print(f"id: {job['id']}")
    print(f"title: {job['title']}")
    print(f"company: {job['company']}")
    print(f"apply_type: {job['apply_type']}")
    print(f"auto_apply_eligible: {job['auto_apply_eligible']}")
    print(f"enrichment_status: {job['enrichment_status']}")
    print(f"c4_ready: {decision.ready}")
    print(f"c4_reason: {decision.reason}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
