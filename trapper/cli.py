from __future__ import annotations

import argparse
import json
from pathlib import Path

from .config import DEFAULT_OG_RESUME_PATH, get_db_path
from .db import get_apply_context, init_resume_db
from .parser import parse_resume_file
from .pipeline import (
    generate_resume_for_ad_hoc,
    generate_resume_for_job,
    generate_resumes_for_ready_jobs,
)
from .renderer import render_resume_tex


def cmd_parse(args: argparse.Namespace) -> int:
    doc = parse_resume_file(args.resume)
    if args.output_json:
        Path(args.output_json).write_text(doc.model_dump_json(indent=2), encoding="utf-8")
    else:
        print(doc.model_dump_json(indent=2))

    if args.roundtrip_tex:
        Path(args.roundtrip_tex).write_text(render_resume_tex(doc), encoding="utf-8")
    return 0


def cmd_init_db(args: argparse.Namespace) -> int:
    init_resume_db(args.db)
    print(f"Initialized resume DB support in {args.db}")
    return 0


def cmd_generate_job(args: argparse.Namespace) -> int:
    result = generate_resume_for_job(args.job_id, db_path=args.db, resume_path=args.resume)
    print(json.dumps(result, indent=2))
    return 0


def cmd_generate_ready(args: argparse.Namespace) -> int:
    results = generate_resumes_for_ready_jobs(
        db_path=args.db,
        limit=args.limit,
        only_missing=args.only_missing,
        resume_path=args.resume,
    )
    print(json.dumps(results, indent=2))
    return 0


def cmd_generate_ad_hoc(args: argparse.Namespace) -> int:
    result = generate_resume_for_ad_hoc(
        title=args.title,
        company=args.company,
        description=Path(args.jd_file).read_text(encoding="utf-8")
        if args.jd_file
        else args.description,
        label=args.label,
        resume_path=args.resume,
    )
    print(json.dumps(result, indent=2))
    return 0


def cmd_apply_context(args: argparse.Namespace) -> int:
    payload = get_apply_context(args.job_id, db_path=args.db)
    if not payload:
        raise SystemExit(f"Job {args.job_id} not found.")
    print(json.dumps(payload, indent=2))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="C2 (Trapper) Stage 0/1 resume tools.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    parse_cmd = subparsers.add_parser(
        "parse-resume", help="Parse the OG resume into structured JSON."
    )
    parse_cmd.add_argument("--resume", default=str(DEFAULT_OG_RESUME_PATH))
    parse_cmd.add_argument("--output-json", default=None)
    parse_cmd.add_argument("--roundtrip-tex", default=None)
    parse_cmd.set_defaults(func=cmd_parse)

    init_cmd = subparsers.add_parser(
        "init-db", help="Add C2 (Trapper) tables/columns to the Hunt DB."
    )
    init_cmd.add_argument("--db", default=str(get_db_path()))
    init_cmd.set_defaults(func=cmd_init_db)

    generate_job = subparsers.add_parser(
        "generate-job", help="Generate a resume attempt for one Hunt job."
    )
    generate_job.add_argument("job_id", type=int)
    generate_job.add_argument("--db", default=str(get_db_path()))
    generate_job.add_argument("--resume", default=str(DEFAULT_OG_RESUME_PATH))
    generate_job.set_defaults(func=cmd_generate_job)

    generate_ready = subparsers.add_parser(
        "generate-ready",
        help="Generate resume attempts for jobs whose enrichment is already done.",
    )
    generate_ready.add_argument("--db", default=str(get_db_path()))
    generate_ready.add_argument("--limit", type=int, default=25)
    generate_ready.add_argument("--only-missing", action="store_true")
    generate_ready.add_argument("--resume", default=str(DEFAULT_OG_RESUME_PATH))
    generate_ready.set_defaults(func=cmd_generate_ready)

    generate_ad_hoc = subparsers.add_parser(
        "generate-ad-hoc", help="Generate a resume attempt from manual JD input."
    )
    generate_ad_hoc.add_argument("--title", required=True)
    generate_ad_hoc.add_argument("--company", default="")
    generate_ad_hoc.add_argument("--description", default="")
    generate_ad_hoc.add_argument("--jd-file", default=None)
    generate_ad_hoc.add_argument("--label", default=None)
    generate_ad_hoc.add_argument("--resume", default=str(DEFAULT_OG_RESUME_PATH))
    generate_ad_hoc.set_defaults(func=cmd_generate_ad_hoc)

    apply_context = subparsers.add_parser(
        "apply-context",
        help="Inspect the C2-side selected-resume context for one job. This is not the shared C4 apply-prep command.",
    )
    apply_context.add_argument("job_id", type=int)
    apply_context.add_argument("--db", default=str(get_db_path()))
    apply_context.set_defaults(func=cmd_apply_context)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
