#!/usr/bin/env python3
import argparse
import base64
import json
import mimetypes
import sys
from datetime import datetime, timezone
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SCRAPER_DIR = REPO_ROOT / "scraper"
if str(SCRAPER_DIR) not in sys.path:
    sys.path.insert(0, str(SCRAPER_DIR))

from db import get_apply_context_for_job, init_db  # noqa: E402


def _build_resume_data_url(pdf_path: str) -> str:
    if not pdf_path:
        return ""

    path = Path(pdf_path)
    if not path.exists() or not path.is_file():
        return ""

    mime_type = mimetypes.guess_type(path.name)[0] or "application/pdf"
    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{encoded}"


def build_apply_prep_payload(job_id: int, *, embed_resume_data: bool = False):
    context = get_apply_context_for_job(job_id)
    if not context:
        raise SystemExit(f"Job {job_id} was not found.")

    payload = {
        "jobId": context["job_id"],
        "title": context["title"],
        "company": context["company"],
        "applyUrl": context["apply_url"],
        "jobUrl": context["job_url"],
        "sourceMode": "c4",
        "source": context["source"],
        "atsType": context["ats_type"],
        "applyType": context["apply_type"],
        "autoApplyEligible": context["auto_apply_eligible"],
        "description": context["description"],
        "selectedResumeVersionId": context["selected_resume_version_id"],
        "selectedResumePath": context["selected_resume_pdf_path"],
        "selectedResumeTexPath": context["selected_resume_tex_path"],
        "selectedResumeReadyForC3": context["selected_resume_ready_for_c3"],
        "jdSnapshotPath": context["latest_resume_job_description_path"],
        "concernFlags": [],
        "primedAt": datetime.now(timezone.utc).isoformat(),
    }

    if context["latest_resume_flags"]:
        try:
            payload["concernFlags"].extend(json.loads(context["latest_resume_flags"]))
        except json.JSONDecodeError:
            payload["concernFlags"].append("resume_flags:unparseable")

    if context["last_enrichment_error"]:
        payload["concernFlags"].append(f"enrichment_error:{context['last_enrichment_error']}")

    if context["enrichment_status"] not in {"done", "done_verified"}:
        payload["concernFlags"].append(f"enrichment_status:{context['enrichment_status']}")

    payload["concernFlags"] = list(dict.fromkeys(flag for flag in payload["concernFlags"] if flag))

    if embed_resume_data:
        payload["selectedResumeDataUrl"] = _build_resume_data_url(
            context["selected_resume_pdf_path"]
        )
        payload["selectedResumeName"] = (
            Path(context["selected_resume_pdf_path"]).name
            if context["selected_resume_pdf_path"]
            else ""
        )
        payload["selectedResumeMimeType"] = "application/pdf"

    return payload


def main():
    parser = argparse.ArgumentParser(
        description="Build an explicit apply context payload for Component 3 / Component 4."
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
        help="Optional path to write the JSON payload to disk.",
    )
    args = parser.parse_args()

    init_db()
    payload = build_apply_prep_payload(
        args.job_id,
        embed_resume_data=args.embed_resume_data,
    )

    rendered = json.dumps(payload, indent=2)
    if args.output:
        output_path = Path(args.output)
        output_path.write_text(rendered + "\n", encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
