"""Verify a discovered employer posting without starting or submitting an application."""

import json
import re
from datetime import timedelta
from functools import cache, partial
from html import unescape
from itertools import count
from urllib.parse import urlsplit

from hunter.discovery_policy import canonical_job_key, normalize_job_url, normalize_text
from hunter.discovery_sources import (
    DEFAULT_PUBLIC_FEEDS,
    career_fetch_plan,
    catalog_error,
    fetch_text,
    public_posting_location,
    resolve_career_fetch_plan,
)
from hunter.job_posting import html_text
from hunter.url_utils import get_apply_host


def _title_matches(job, title):
    # Curated feeds shorten titles. Exact board/requisition checks still establish identity;
    # the employer's title replaces the feed label before eligibility is reassessed.
    return bool(normalize_text(title)) and (
        normalize_text(title) == normalize_text(job.get("title"))
        or job.get("source") in DEFAULT_PUBLIC_FEEDS
    )


def _verified_result(provider, row, description, url):
    if len(description) < 50:
        raise ValueError("description_not_found")
    title_field = {"lever": "text", "bamboohr": "jobOpeningName", "smartrecruiters": "name"}.get(
        provider, "title"
    )
    return {
        "title": row[title_field],
        "description": description,
        "location": public_posting_location(provider, row),
        "apply_type": "external_apply",
        "auto_apply_eligible": True,
        "apply_url": url,
        "apply_host": get_apply_host(url),
        "ats_type": provider,
    }


def verify_workday_posting(job, *, fetcher=fetch_text):
    """Require live employer evidence for the exact requisition and an open apply route."""
    if job.get("apply_type") == "easy_apply":
        raise ValueError("easy_apply_ineligible")
    url = job.get("apply_url") or job.get("job_url") or ""
    plan = career_fetch_plan(url)
    path = urlsplit(url).path
    if plan["method"] != "workday" or "/job/" not in path:
        raise ValueError("public_provider_not_supported")
    detail_path = "/job/" + path.split("/job/", 1)[1]
    payload = json.loads(fetcher(plan["url"] + detail_path))
    detail = payload.get("jobPostingInfo") if isinstance(payload, dict) else None
    if not isinstance(detail, dict):
        raise ValueError("public_posting_missing")
    if detail.get("canApply") is False:
        raise ValueError("job_removed")
    if detail.get("canApply") is not True:
        raise ValueError("public_application_availability_unknown")
    external = detail.get("externalUrl") or ""
    external_plan = career_fetch_plan(external)
    if (
        external_plan["method"] != "workday"
        or external_plan["url"].lower() != plan["url"].lower()
        or canonical_job_key(external, job.get("company"))
        != canonical_job_key(url, job.get("company"))
        or not _title_matches(job, detail.get("title"))
    ):
        raise ValueError("public_posting_identity_mismatch")
    description = html_text(detail.get("jobDescription") or "")
    return _verified_result("workday", detail, description, external)


def verify_public_posting(job, *, fetcher=fetch_text):
    if job.get("apply_type") == "easy_apply":
        raise ValueError("easy_apply_ineligible")
    url = job.get("apply_url") or job.get("job_url") or ""
    plan = career_fetch_plan(url)
    if plan["method"] == "manual" and job.get("ats_type") == "greenhouse":
        known = {}
        for observed_url in [job.get("job_url"), *(job.get("source_urls") or [])]:
            observed = career_fetch_plan(observed_url)
            if observed["method"] == "greenhouse":
                known[observed["url"]] = observed
        if len(known) > 1:
            raise ValueError("public_provider_ambiguous")
        plan = (
            next(iter(known.values()))
            if known
            else resolve_career_fetch_plan(url, fetcher=fetcher, follow_links=False)
        )
    provider = plan["method"]
    if provider == "workday":
        return verify_workday_posting(job, fetcher=fetcher)
    if provider == "smartrecruiters":
        return verify_smartrecruiters_posting(job, plan, fetcher=fetcher)
    if provider == "bamboohr":
        return verify_bamboohr_posting(job, plan, fetcher=fetcher)
    if provider == "workable":
        return verify_workable_posting(job, plan, fetcher=fetcher)
    if provider not in {"greenhouse", "lever", "ashby"}:
        raise ValueError("public_provider_not_supported")
    payload = json.loads(fetcher(plan["url"]))
    rows = (
        payload
        if provider == "lever"
        else payload.get("jobs")
        if isinstance(payload, dict)
        else None
    )
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("invalid_employer_catalog")
    url_field = {"greenhouse": "absolute_url", "lever": "hostedUrl", "ashby": "jobUrl"}[provider]
    key = canonical_job_key(url, job.get("company"))
    # The board's own catalog may publish a custom-domain URL for an embedded job.
    greenhouse_id = (
        key.rsplit(":", 1)[-1]
        if provider == "greenhouse" and key.startswith("greenhouse:")
        else None
    )
    matches = [
        row
        for row in rows
        if canonical_job_key(row.get(url_field), job.get("company")) == key
        or (greenhouse_id is not None and str(row.get("id")) == greenhouse_id)
    ]
    if not matches:
        raise ValueError("job_removed")
    if len(matches) != 1:
        raise ValueError("public_posting_identity_mismatch")
    row = matches[0]
    if row.get("isListed") is False:
        raise ValueError("job_removed")
    title = row.get("text") if provider == "lever" else row.get("title")
    external = row.get("absolute_url") if provider == "greenhouse" else row.get("applyUrl")
    if (
        not _title_matches(job, title)
        or not normalize_job_url(external)
        or (provider != "greenhouse" and career_fetch_plan(external) != plan)
        or (provider != "greenhouse" and canonical_job_key(external, job.get("company")) != key)
    ):
        raise ValueError("public_posting_identity_mismatch")
    if provider == "lever":
        sections = [row.get("descriptionPlain") or row.get("description") or ""]
        for section in row.get("lists") or []:
            sections.extend([section.get("text") or "", section.get("content") or ""])
        sections.append(row.get("additionalPlain") or row.get("additional") or "")
        content = "\n".join(sections)
    elif provider == "greenhouse":
        content = unescape(row.get("content") or "")
    else:
        content = row.get("descriptionPlain") or row.get("descriptionHtml") or ""
    description = html_text(content)
    return _verified_result(provider, row, description, external)


def verify_workable_posting(job, plan, *, fetcher=fetch_text):
    url = job.get("apply_url") or job.get("job_url") or ""
    match = re.fullmatch(r"/([^/]+)/j/([0-9a-f]{10})(?:/apply)?/?", urlsplit(url).path, re.I)
    if not match:
        raise ValueError("public_posting_identity_mismatch")
    tenant, identity = match.groups()
    row = json.loads(
        fetcher(f"https://apply.workable.com/api/v2/accounts/{tenant}/jobs/{identity}")
    )
    if (
        not isinstance(row, dict)
        or str(row.get("shortcode", "")).lower() != identity.lower()
        or not _title_matches(job, row.get("title"))
    ):
        raise ValueError("public_posting_identity_mismatch")
    if row.get("state") != "published" or row.get("isInternal") is not False:
        raise ValueError("public_application_availability_unknown")
    description = "\n".join(
        html_text(row.get(section) or "") for section in ("description", "requirements", "benefits")
    ).strip()
    external = plan["url"] + "j/" + identity + "/"
    return _verified_result("workable", row, description, external)


def verify_bamboohr_posting(job, plan, *, fetcher=fetch_text):
    url = job.get("apply_url") or job.get("job_url") or ""
    key = canonical_job_key(url)
    if not key.startswith("bamboohr:"):
        raise ValueError("public_posting_identity_mismatch")
    identity = key.rsplit(":", 1)[-1]
    payload = json.loads(fetcher(plan["url"] + "/" + identity + "/detail"))
    row = (payload.get("result") or {}).get("jobOpening")
    if not isinstance(row, dict):
        raise ValueError("public_posting_missing")
    external = row.get("jobOpeningShareUrl") or ""
    if (
        canonical_job_key(external) != key
        or not _title_matches(job, row.get("jobOpeningName"))
        or urlsplit(external).scheme != "https"
    ):
        raise ValueError("public_posting_identity_mismatch")
    if row.get("jobOpeningStatus") != "Open":
        raise ValueError("public_application_availability_unknown")
    description = html_text(unescape(row.get("description") or ""))
    return _verified_result("bamboohr", row, description, external)


def verify_smartrecruiters_posting(job, plan, *, fetcher=fetch_text):
    url = job.get("apply_url") or job.get("job_url") or ""
    key = canonical_job_key(url)
    if not key.startswith("smartrecruiters:"):
        raise ValueError("public_posting_identity_mismatch")
    identity = key.rsplit(":", 1)[-1]
    row = json.loads(fetcher(plan["url"] + "/" + identity))
    if not isinstance(row, dict) or str(row.get("id")) != identity:
        raise ValueError("public_posting_identity_mismatch")
    if row.get("active") is False or row.get("visibility") == "PRIVATE":
        raise ValueError("job_removed")
    if row.get("active") is not True or row.get("visibility") != "PUBLIC":
        raise ValueError("public_application_availability_unknown")
    external = row.get("applyUrl") or ""
    if (
        not _title_matches(job, row.get("name"))
        or canonical_job_key(row.get("postingUrl")) != key
        or canonical_job_key(external) != key
        or urlsplit(external).scheme != "https"
    ):
        raise ValueError("public_posting_identity_mismatch")
    sections = (row.get("jobAd") or {}).get("sections") or {}
    description = "\n".join(
        html_text(section.get("text") or "")
        for section in sections.values()
        if isinstance(section, dict)
    ).strip()
    return _verified_result("smartrecruiters", row, description, external)


def process_public_verification_batch(*, limit=25, verifier=None):
    from hunter.config import ENRICHMENT_MAX_ATTEMPTS
    from hunter.db import (
        claim_public_employer_job,
        mark_job_enrichment_failed,
        mark_job_enrichment_succeeded,
    )
    from hunter.enrichment_policy import format_sqlite_timestamp, utc_now

    if verifier is None:
        # One live catalog snapshot per board per batch, never a persistent stale cache.
        cached_fetch = cache(fetch_text)
        verifier = partial(verify_public_posting, fetcher=cached_fetch)
    summary = {
        "attempted": 0,
        "verified": 0,
        "failed": 0,
        "superseded": 0,
        "actionable_failed": 0,
        "failure_breakdown": {},
    }
    for _ in count() if limit is None else range(max(0, limit)):
        job = claim_public_employer_job()
        if job is None:
            break
        summary["attempted"] += 1
        guard = {"source": job["source"], "expected_started_at": job["last_enrichment_started_at"]}
        try:
            result = verifier(job)
        except Exception as exc:
            error = catalog_error(exc)
            terminal = error in {"job_removed", "easy_apply_ineligible"}
            updated = mark_job_enrichment_failed(
                job["id"],
                error,
                enrichment_status="failed" if terminal else "blocked",
                auto_apply_eligible=False,
                next_enrichment_retry_at=None
                if terminal
                else format_sqlite_timestamp(
                    utc_now()
                    + timedelta(
                        hours=24
                        if job.get("enrichment_attempts", 0) >= ENRICHMENT_MAX_ATTEMPTS
                        else 1
                    )
                ),
                **guard,
            )
            summary["failed" if updated else "superseded"] += 1
            if updated:
                summary["failure_breakdown"][error] = summary["failure_breakdown"].get(error, 0) + 1
                summary["actionable_failed"] += int(not terminal)
        else:
            updated = mark_job_enrichment_succeeded(job["id"], **result, **guard)
            summary["verified" if updated else "superseded"] += 1
    return summary
