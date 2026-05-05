#!/usr/bin/env python3
"""Run deployed Option B smoke tests against enriched jobs.

This script selects real enriched jobs from the Hunt DB, submits their job
description to the review app's `/api/fletcher/tailor` endpoint, saves returned
PDF/log artifacts, and writes a compact smoke summary for each run.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from random import Random
from typing import Any

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from fletcher.config import DEFAULT_OG_RESUME_PATH  # noqa: E402
from hunter.db import get_connection  # noqa: E402


@dataclass(frozen=True)
class SmokeJob:
    id: int
    title: str
    company: str
    source: str
    enrichment_status: str
    description: str


def _slug(value: str, max_len: int = 80) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", value).strip("_").lower()
    return (slug or "item")[:max_len].strip("_") or "item"


def _row_get(row: Any, key: str, default: Any = "") -> Any:
    try:
        return row[key]
    except Exception:
        return default


def load_candidate_jobs(
    *,
    limit: int,
    min_description_chars: int,
    job_ids: list[int] | None = None,
) -> list[SmokeJob]:
    conn = get_connection()
    try:
        params: list[Any] = [min_description_chars]
        id_filter = ""
        if job_ids:
            placeholders = ",".join("?" for _ in job_ids)
            id_filter = f" AND id IN ({placeholders})"
            params.extend(job_ids)
        params.append(max(limit, len(job_ids or []), 1))
        rows = conn.execute(
            f"""
            SELECT id, title, company, source, enrichment_status, description
            FROM jobs
            WHERE enrichment_status IN ('done', 'done_verified')
              AND description IS NOT NULL
              AND length(trim(description)) >= ?
              {id_filter}
            ORDER BY coalesce(enriched_at, date_scraped, '') DESC, id DESC
            LIMIT ?
            """,
            tuple(params),
        ).fetchall()
    finally:
        conn.close()

    jobs: list[SmokeJob] = []
    for row in rows:
        jobs.append(
            SmokeJob(
                id=int(_row_get(row, "id")),
                title=str(_row_get(row, "title") or ""),
                company=str(_row_get(row, "company") or ""),
                source=str(_row_get(row, "source") or ""),
                enrichment_status=str(_row_get(row, "enrichment_status") or ""),
                description=str(_row_get(row, "description") or ""),
            )
        )
    return jobs


def choose_jobs(candidates: list[SmokeJob], *, count: int, seed: int | None) -> list[SmokeJob]:
    items = list(candidates)
    Random(seed).shuffle(items)
    return items[: max(count, 0)]


def _decode_b64_to_file(value: str | None, path: Path, *, text: bool = False) -> bool:
    if not value:
        return False
    raw = base64.b64decode(value)
    path.parent.mkdir(parents=True, exist_ok=True)
    if text:
        path.write_text(raw.decode("utf-8", errors="replace"), encoding="utf-8")
    else:
        path.write_bytes(raw)
    return True


def summarize_pipeline_log(log_text: str) -> dict[str, Any]:
    lines = log_text.splitlines()
    interesting_names = (
        "config",
        "classify_done",
        "keywords_extracted",
        "keyword_policy_partition",
        "rag_complete",
        "bullet_rewrites_summary",
        "rewrite_validation_summary",
        "summary_keyword_filter",
        "summary_validation",
        "summary_line_check",
        "summary_generation_error",
        "done",
    )
    interesting = [
        line.strip() for line in lines if any(name in line for name in interesting_names)
    ]
    return {
        "line_count": len(lines),
        "has_done": any(" done" in line or "] done" in line for line in lines),
        "has_error": any(
            marker in log_text
            for marker in (
                "FAILED",
                "summary_generation_error",
                "Traceback",
                "Internal Server Error",
            )
        ),
        "rewrite_validation_failed_count": log_text.count("rewrite_validation_failed"),
        "claimed_keyword_missing_count": log_text.count("claimed_keyword_missing"),
        "interesting": interesting[:40],
    }


def _extract_pdf_text(pdf_path: Path, txt_path: Path) -> bool:
    pdftotext = shutil.which("pdftotext")
    if not pdftotext or not pdf_path.exists():
        return False
    result = subprocess.run(
        [pdftotext, "-layout", str(pdf_path), str(txt_path)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    return result.returncode == 0 and txt_path.exists()


def _save_review_tail(out_dir: Path, container: str, tail: int) -> None:
    if tail <= 0 or not shutil.which("docker"):
        return
    result = subprocess.run(
        ["docker", "logs", container, "--tail", str(tail)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    (out_dir / "docker_review_tail.txt").write_text(
        (result.stdout or "") + (result.stderr or ""),
        encoding="utf-8",
    )


def login(session: requests.Session, *, review_url: str, username: str, password: str) -> None:
    response = session.post(
        f"{review_url.rstrip('/')}/auth/login",
        json={"username": username, "password": password},
        timeout=30,
    )
    response.raise_for_status()


def call_option_b(
    session: requests.Session,
    *,
    review_url: str,
    job: SmokeJob,
    resume_path: Path,
    timeout: int,
) -> dict[str, Any]:
    with resume_path.open("rb") as resume_file:
        response = session.post(
            f"{review_url.rstrip('/')}/api/fletcher/tailor",
            data={
                "job_details": f"{job.title}\n{job.company}\n{job.description}",
                "personal_details": "",
            },
            files={"resume": (resume_path.name, resume_file, "application/octet-stream")},
            timeout=timeout,
        )
    response.raise_for_status()
    return response.json()


def run_smoke(args: argparse.Namespace) -> int:
    if args.db_url:
        os.environ["HUNT_DB_URL"] = args.db_url

    out_root = Path(args.out_dir)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = out_root / f"option_b_smoke_{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)

    candidates = load_candidate_jobs(
        limit=args.candidate_limit,
        min_description_chars=args.min_description_chars,
        job_ids=args.job_id,
    )
    selected = choose_jobs(candidates, count=args.count, seed=args.seed)
    if not selected:
        print("[option-b-smoke] No enriched jobs found for smoke run.")
        return 1

    manifest: dict[str, Any] = {
        "started_at": stamp,
        "review_url": args.review_url,
        "resume": str(Path(args.resume).resolve()),
        "selected_jobs": [
            asdict(job) | {"description": f"{len(job.description)} chars"} for job in selected
        ],
        "runs": [],
    }

    if args.dry_run:
        (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        print(f"[option-b-smoke] Dry run selected {len(selected)} job(s).")
        print(f"[option-b-smoke] Manifest: {run_dir / 'manifest.json'}")
        return 0

    session = requests.Session()
    login(
        session,
        review_url=args.review_url,
        username=args.username,
        password=args.password,
    )

    for idx, job in enumerate(selected, 1):
        label = f"{idx:02d}_job_{job.id}_{_slug(job.company)}_{_slug(job.title)}"
        job_dir = run_dir / label
        job_dir.mkdir(parents=True, exist_ok=True)
        (job_dir / "job.json").write_text(
            json.dumps(asdict(job), indent=2),
            encoding="utf-8",
        )
        print(f"[option-b-smoke] {idx}/{len(selected)} job_id={job.id} title={job.title!r}")
        started = time.perf_counter()
        run_summary: dict[str, Any] = {
            "job_id": job.id,
            "title": job.title,
            "company": job.company,
            "status": "unknown",
            "duration_sec": None,
            "artifacts": {},
            "log_summary": {},
        }
        try:
            payload = call_option_b(
                session,
                review_url=args.review_url,
                job=job,
                resume_path=Path(args.resume),
                timeout=args.timeout,
            )
            run_summary["status"] = "ok"
            run_summary["compile_status"] = payload.get("compile_status")
            run_summary["fits_one_page"] = payload.get("fits_one_page")
            run_summary["llm_error"] = payload.get("llm_error")

            artifacts = {
                "resume_no_summary_pdf": job_dir / "resume_no_summary.pdf",
                "resume_with_summary_pdf": job_dir / "resume_with_summary.pdf",
                "pipeline_log": job_dir / "pipeline_log.txt",
            }
            no_summary = _decode_b64_to_file(
                payload.get("no_summary"), artifacts["resume_no_summary_pdf"]
            )
            with_summary = _decode_b64_to_file(
                payload.get("with_summary"),
                artifacts["resume_with_summary_pdf"],
            )
            has_log = _decode_b64_to_file(payload.get("log"), artifacts["pipeline_log"], text=True)
            run_summary["artifacts"] = {
                "resume_no_summary_pdf": str(artifacts["resume_no_summary_pdf"])
                if no_summary
                else None,
                "resume_with_summary_pdf": str(artifacts["resume_with_summary_pdf"])
                if with_summary
                else None,
                "pipeline_log": str(artifacts["pipeline_log"]) if has_log else None,
            }
            if has_log:
                log_text = artifacts["pipeline_log"].read_text(encoding="utf-8", errors="replace")
                run_summary["log_summary"] = summarize_pipeline_log(log_text)
            for pdf_key, txt_name in (
                ("resume_no_summary_pdf", "resume_no_summary.txt"),
                ("resume_with_summary_pdf", "resume_with_summary.txt"),
            ):
                pdf_value = run_summary["artifacts"].get(pdf_key)
                if pdf_value:
                    _extract_pdf_text(Path(pdf_value), job_dir / txt_name)
            _save_review_tail(job_dir, args.docker_container, args.docker_tail)
        except Exception as exc:
            run_summary["status"] = "failed"
            run_summary["error"] = str(exc) or exc.__class__.__name__
            (job_dir / "error.txt").write_text(run_summary["error"], encoding="utf-8")
            _save_review_tail(job_dir, args.docker_container, args.docker_tail)
        finally:
            run_summary["duration_sec"] = round(time.perf_counter() - started, 3)
            (job_dir / "summary.json").write_text(
                json.dumps(run_summary, indent=2),
                encoding="utf-8",
            )
            manifest["runs"].append(run_summary)

    manifest["finished_at"] = datetime.now().strftime("%Y%m%d-%H%M%S")
    (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"[option-b-smoke] Done. Manifest: {run_dir / 'manifest.json'}")
    failed = [run for run in manifest["runs"] if run.get("status") != "ok"]
    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run deployed Option B smokes on enriched jobs.")
    parser.add_argument("--count", type=int, default=3)
    parser.add_argument("--candidate-limit", type=int, default=50)
    parser.add_argument("--min-description-chars", type=int, default=500)
    parser.add_argument("--job-id", type=int, action="append", default=None)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument(
        "--review-url", default=os.getenv("HUNT_REVIEW_URL", "http://127.0.0.1:18080")
    )
    parser.add_argument("--db-url", default=os.getenv("HUNT_DB_URL", ""))
    parser.add_argument("--username", default=os.getenv("HUNT_ADMIN_USERNAME", "admin"))
    parser.add_argument("--password", default=os.getenv("HUNT_ADMIN_PASSWORD", "hunt-local-admin"))
    parser.add_argument("--resume", default=str(DEFAULT_OG_RESUME_PATH))
    parser.add_argument("--out-dir", default=".runtime/option-b-smokes")
    parser.add_argument("--timeout", type=int, default=420)
    parser.add_argument("--docker-container", default="hunt-review-1")
    parser.add_argument("--docker-tail", type=int, default=300)
    parser.add_argument("--dry-run", action="store_true")
    return parser


def main() -> int:
    return run_smoke(build_parser().parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
