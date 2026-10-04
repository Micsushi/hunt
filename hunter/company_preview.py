"""Read-only employer onboarding: python -m hunter.company_preview NAME URL."""

import argparse
import json
import time
from functools import partial
from urllib.parse import urlsplit

from hunter.discovery_policy import annotate_job
from hunter.discovery_sources import (
    _error_code,
    discover_company_career_site,
    fetch_text,
    post_public_json,
    resolve_career_fetch_plan,
)


def preview_company(company, url, *, fetcher=fetch_text, poster=post_public_json):
    parts = urlsplit(url)
    if (
        not company.strip()
        or parts.scheme not in {"http", "https"}
        or not parts.hostname
        or parts.username is not None
    ):
        raise ValueError("Provide a company name and a public HTTP(S) careers URL")
    result = {"company": company, "career_site": url, "sample": [], "saved": False}
    requests = 0
    deadline = time.monotonic() + 20

    def bounded(call, *args, **kwargs):
        nonlocal requests
        requests += 1
        if requests > 12 or time.monotonic() >= deadline:
            raise ValueError("preview_request_limit")
        if call in {fetch_text, post_public_json}:
            return call(
                *args, timeout=min(3, max(0.1, (deadline - time.monotonic()) / 3)), **kwargs
            )
        return call(*args, **kwargs)

    read = partial(bounded, fetcher)
    try:
        plan = resolve_career_fetch_plan(url, fetcher=read)
    except Exception as exc:
        return {
            **result,
            "status": "failed",
            "error": _error_code(exc),
        }
    # Browser-only readers need their normal isolated scan, not an unbounded preview request.
    if plan["method"] in {
        "gc_jobs",
        "taleo",
        "dayforce",
        "ibm",
        "peoplesoft",
        "technomedia",
        "ukg",
        "hibob",
        "sap",
    }:
        return {
            **result,
            "plan": plan,
            "status": "needs_scan",
            "error": "browser_scan_required",
        }
    if plan.get("boards"):
        return {
            **result,
            "plan": plan,
            "status": "needs_setup",
            "error": "ambiguous_career_boards",
        }
    jobs, health = discover_company_career_site(
        company,
        url,
        fetcher=read,
        poster=partial(bounded, poster),
        resolved_plan=plan if plan["method"] != "manual" else None,
    )
    return {
        **result,
        "plan": {key: health.get(key, plan.get(key)) for key in ("method", "url")},
        "status": health["status"],
        "error": health.get("error"),
        "matched": len(jobs),
        "requests": min(requests, 12),
        "sample": [
            {
                key: job.get(key)
                for key in (
                    "title",
                    "location",
                    "job_url",
                    "date_posted",
                    "discovery_suppressed_reason",
                )
            }
            for job in (annotate_job(row) for row in jobs[:5])
        ],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("company")
    parser.add_argument("url")
    arguments = parser.parse_args()
    print(
        json.dumps(preview_company(arguments.company, arguments.url), indent=2, ensure_ascii=False)
    )
