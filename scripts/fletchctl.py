#!/usr/bin/env python3
"""
C2 (Fletcher) operator CLI.

This is intentionally separate from `hunterctl` so `hunter ...` remains C1-only.
"""

from __future__ import annotations

import argparse
import os
import shlex
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
IS_WINDOWS = os.name == "nt"


def _find_repo_python() -> str:
    candidates = []
    if IS_WINDOWS:
        candidates.extend(
            [
                REPO_ROOT / ".venv" / "Scripts" / "python.exe",
                REPO_ROOT / "venv" / "Scripts" / "python.exe",
            ]
        )
    else:
        candidates.extend([REPO_ROOT / ".venv" / "bin" / "python", REPO_ROOT / "venv" / "bin" / "python"])
    for c in candidates:
        if c.exists():
            return str(c)
    return sys.executable


PYTHON = _find_repo_python()


def _run(argv, *, env=None):
    final_env = os.environ.copy()
    if env:
        final_env.update(env)
    print("[fletchctl] Running:", " ".join(shlex.quote(str(part)) for part in argv))
    raise SystemExit(subprocess.run(argv, cwd=REPO_ROOT, env=final_env).returncode)


def cmd_fletcher(args):
    # Thin wrapper around the module CLI.
    argv = [PYTHON, "-m", "fletcher.cli"] + args.fletcher_args
    _run(argv)


def _run_fletcher_cli(argv_tail: list[str]):
    _run([PYTHON, "-m", "fletcher.cli"] + argv_tail)


def cmd_init_db(args):
    argv = ["init-db"]
    if args.db:
        argv += ["--db", args.db]
    _run_fletcher_cli(argv)


def cmd_generate_job(args):
    argv = ["generate-job", str(args.job_id)]
    if args.db:
        argv += ["--db", args.db]
    if args.resume:
        argv += ["--resume", args.resume]
    _run_fletcher_cli(argv)


def cmd_generate_ready(args):
    argv = ["generate-ready", "--limit", str(args.limit)]
    if args.only_missing:
        argv.append("--only-missing")
    if args.db:
        argv += ["--db", args.db]
    if args.resume:
        argv += ["--resume", args.resume]
    _run_fletcher_cli(argv)


def cmd_generate_ad_hoc(args):
    argv = [
        "generate-ad-hoc",
        "--title",
        args.title,
        "--company",
        args.company or "",
        "--description",
        args.description or "",
    ]
    if args.jd_file:
        argv += ["--jd-file", args.jd_file]
    if args.label:
        argv += ["--label", args.label]
    if args.resume:
        argv += ["--resume", args.resume]
    _run_fletcher_cli(argv)


def cmd_apply_context(args):
    argv = ["apply-context", str(args.job_id)]
    if args.db:
        argv += ["--db", args.db]
    _run_fletcher_cli(argv)


def cmd_parse_resume(args):
    argv = ["parse-resume"]
    if args.resume:
        argv += ["--resume", args.resume]
    if args.output_json:
        argv += ["--output-json", args.output_json]
    if args.roundtrip_tex:
        argv += ["--roundtrip-tex", args.roundtrip_tex]
    _run_fletcher_cli(argv)


def cmd_test_job(args):
    import json
    import time
    sys.path.insert(0, str(REPO_ROOT))
    from fletcher.pipeline import generate_resume_for_job

    print(f"[fletchctl] Testing job {args.job_id} ...")
    start = time.time()
    r = generate_resume_for_job(args.job_id)
    elapsed = time.time() - start

    print(f"\n--- Result ---")
    print(f"Total time  : {elapsed:.1f}s")
    print(f"Status      : {r['status']}")
    print(f"Compile     : {r['compile_status']}")
    print(f"Fits 1 page : {r['fits_one_page']}")
    print(f"PDF         : {r.get('pdf_path') or '—'}")

    summary_path = r.get("summary_rewrite_path")
    if summary_path:
        try:
            data = json.loads(Path(summary_path).read_text(encoding="utf-8"))
            print(f"\n--- AI Summary (call 2) ---")
            print(f"Success     : {data.get('success')}")
            print(f"Duration    : {data.get('duration_ms')}ms")
            print(f"Keywords    : {data.get('keywords_used')}")
            print(f"Text        :\n  {data.get('summary', '(empty)')}")
        except Exception as e:
            print(f"Summary file error: {e}")
    else:
        print("\nAI Summary  : not generated (ollama backend not active?)")

    bullet_path = r.get("bullet_rewrite_path")
    if bullet_path:
        try:
            data = json.loads(Path(bullet_path).read_text(encoding="utf-8"))
            print(f"\n--- Bullet rewrite (call 3) ---")
            print(f"Success     : {data.get('success')}")
            print(f"Duration    : {data.get('duration_ms')}ms")
            print(f"Keywords    : {data.get('keywords_used')}")
            bullets = data.get("bullets") or []
            for i, b in enumerate(bullets, 1):
                print(f"  {i}. {b}")
        except Exception as e:
            print(f"Bullet file error: {e}")
    else:
        print("Bullet rewrite: not generated")

    raise SystemExit(0)


def cmd_index(args):
    import json
    sys.path.insert(0, str(REPO_ROOT))
    from fletcher import rag, config

    action = args.action
    if action == "build":
        print("[fletchctl] Building RAG index (verbose)...")
        result = rag.build_index(
            config.DEFAULT_OG_RESUME_PATH,
            config.DEFAULT_CANDIDATE_PROFILE_PATH,
            config.DEFAULT_BULLET_LIBRARY_PATH,
            verbose=True,
        )
        print(
            f"[fletchctl] Done: {result['embedded']} docs embedded, "
            f"{result['duration_ms']}ms, {result['errors']} errors."
        )
    elif action == "status":
        status = rag.index_status()
        if not status.get("built"):
            print("[fletchctl] RAG index: not built.")
        else:
            print(json.dumps(status, indent=2))
    elif action == "clear":
        rag.clear_index()
        print("[fletchctl] RAG index cleared.")
    raise SystemExit(0)


def cmd_tests(_args):
    patterns = [
        "test_component2_stage1.py",
        "test_component2_pipeline.py",
        "test_component2_ollama.py",
        "test_resume_review_ui.py",
    ]
    for pattern in patterns:
        result = subprocess.run([PYTHON, "-m", "unittest", "discover", "-s", "tests", "-p", pattern, "-v"], cwd=REPO_ROOT)
        if result.returncode != 0:
            raise SystemExit(result.returncode)
    raise SystemExit(0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="C2 (Fletcher) operator CLI.")
    sub = parser.add_subparsers(dest="command", required=True)

    tests = sub.add_parser("tests", help="Run C2 unit tests.")
    tests.set_defaults(func=cmd_tests)

    init_db = sub.add_parser("init-db", help="Initialize C2 tables/columns in a Hunt SQLite DB.")
    init_db.add_argument("--db", default=None)
    init_db.set_defaults(func=cmd_init_db)

    job = sub.add_parser("job", help="Generate a resume for one Hunt job id.")
    job.add_argument("job_id", type=int)
    job.add_argument("--db", default=None)
    job.add_argument("--resume", default=None)
    job.set_defaults(func=cmd_generate_job)

    ready = sub.add_parser("ready", help="Batch-generate resumes for done/done_verified jobs.")
    ready.add_argument("--limit", type=int, default=25)
    ready.add_argument("--only-missing", action="store_true")
    ready.add_argument("--db", default=None)
    ready.add_argument("--resume", default=None)
    ready.set_defaults(func=cmd_generate_ready)

    ad_hoc = sub.add_parser("ad-hoc", help="Generate from a pasted JD (no DB job).")
    ad_hoc.add_argument("--title", required=True)
    ad_hoc.add_argument("--company", default="")
    ad_hoc.add_argument("--description", default="")
    ad_hoc.add_argument("--jd-file", default=None, dest="jd_file")
    ad_hoc.add_argument("--label", default=None)
    ad_hoc.add_argument("--resume", default=None)
    ad_hoc.set_defaults(func=cmd_generate_ad_hoc)

    ctx = sub.add_parser("context", help="Print C2 apply context for one job.")
    ctx.add_argument("job_id", type=int)
    ctx.add_argument("--db", default=None)
    ctx.set_defaults(func=cmd_apply_context)

    parse = sub.add_parser("parse", help="Parse main.tex (or --resume) to JSON / round-trip TeX.")
    parse.add_argument("--resume", default=None)
    parse.add_argument("--output-json", default=None, dest="output_json")
    parse.add_argument("--roundtrip-tex", default=None, dest="roundtrip_tex")
    parse.set_defaults(func=cmd_parse_resume)

    test_job = sub.add_parser("test-job", help="Run pipeline on one job and print timing + LLM output.")
    test_job.add_argument("job_id", type=int)
    test_job.set_defaults(func=cmd_test_job)

    index = sub.add_parser("index", help="Manage the RAG vector index.")
    index.add_argument("action", choices=["build", "status", "clear"], help="build: force rebuild | status: show info | clear: delete index")
    index.set_defaults(func=cmd_index)

    fx = sub.add_parser(
        "run",
        help="Delegate to `python -m fletcher.cli ...` (pass through remaining args).",
    )
    fx.add_argument("fletcher_args", nargs=argparse.REMAINDER)
    fx.set_defaults(func=cmd_fletcher)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    args.func(args)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

