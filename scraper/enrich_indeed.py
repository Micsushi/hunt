import argparse
import json
import os
import re
import sys
import time
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from db import (  # noqa: E402
    claim_job_for_enrichment,
    get_job_by_id,
    mark_job_enrichment_failed,
    mark_job_enrichment_succeeded,
)
from enrichment_policy import compute_retry_after, format_sqlite_timestamp  # noqa: E402
from url_utils import detect_ats_type, get_apply_host, normalize_apply_url, normalize_optional_str  # noqa: E402


SOURCE = "indeed"
REQUEST_TIMEOUT_SECONDS = 45
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/135.0.0.0 Safari/537.36"
)
DESCRIPTION_SELECTORS = (
    "#jobDescriptionText",
    '[data-testid="jobsearch-JobComponent-description"]',
    ".jobsearch-JobComponent-description",
    ".jobsearch-jobDescriptionText",
    "main",
    "article",
)
APPLY_LINK_SELECTORS = (
    '[data-testid="indeedApplyButton"] a[href]',
    '[data-testid="apply-button"] a[href]',
    "#indeedApplyButtonContainer a[href]",
    "a.icl-Button[href]",
    "a[href]",
)
JOB_REMOVED_PATTERNS = (
    "job has expired",
    "job no longer available",
    "position has been filled",
    "page not found",
    "this job is no longer available",
)
RATE_LIMIT_PATTERNS = (
    "too many requests",
    "unusual traffic",
    "please verify you are a human",
    "try again later",
    "rate limit",
)
APPLY_TEXT_RE = re.compile(r"\b(apply|continue application|apply now|apply on company site)\b", re.IGNORECASE)


class IndeedEnrichmentError(RuntimeError):
    def __init__(self, code, message, *, partial_result=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.partial_result = partial_result


def _session():
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }
    )
    return session


def _normalize_text(value):
    normalized = normalize_optional_str(value)
    if not normalized:
        return None
    normalized = re.sub(r"\r\n?", "\n", normalized)
    lines = [re.sub(r"\s+", " ", line).strip() for line in normalized.splitlines()]
    cleaned = "\n".join(line for line in lines if line)
    return cleaned or None


def _html_to_text(value):
    normalized = normalize_optional_str(value)
    if not normalized:
        return None
    soup = BeautifulSoup(normalized, "html.parser")
    return _normalize_text(soup.get_text("\n", strip=True))


def _is_usable_description(value, *, minimum_length=50):
    normalized = _normalize_text(value)
    return bool(normalized and len(normalized) >= minimum_length)


def _find_job_posting_json(soup):
    for script in soup.select('script[type="application/ld+json"]'):
        raw = normalize_optional_str(script.string or script.get_text())
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue

        stack = payload if isinstance(payload, list) else [payload]
        while stack:
            item = stack.pop()
            if isinstance(item, list):
                stack.extend(item)
                continue
            if not isinstance(item, dict):
                continue
            if item.get("@type") == "JobPosting":
                return item
            for value in item.values():
                if isinstance(value, (dict, list)):
                    stack.append(value)
    return None


def _detect_job_removed(text):
    lower_text = (text or "").lower()
    return any(pattern in lower_text for pattern in JOB_REMOVED_PATTERNS)


def _detect_rate_limited(response, text):
    if response.status_code in (429, 503):
        return True
    lower_text = (text or "").lower()
    return any(pattern in lower_text for pattern in RATE_LIMIT_PATTERNS)


def _extract_description(soup, job_posting):
    if job_posting:
        description = _html_to_text(job_posting.get("description"))
        if description:
            return description

    for selector in DESCRIPTION_SELECTORS:
        node = soup.select_one(selector)
        if not node:
            continue
        description = _normalize_text(node.get_text("\n", strip=True))
        if description and len(description) >= 50:
            return description

    raise IndeedEnrichmentError(
        "description_not_found",
        "Could not extract a usable description from the Indeed job page.",
    )


def _resolve_candidate_apply_url(session, candidate_url):
    normalized = normalize_apply_url(candidate_url)
    if not normalized:
        return None

    host = (urlparse(normalized).netloc or "").lower()
    if host and "indeed." not in host:
        return normalized

    try:
        response = session.get(
            normalized,
            timeout=REQUEST_TIMEOUT_SECONDS,
            allow_redirects=True,
        )
    except requests.RequestException:
        return normalized

    redirected = normalize_apply_url(response.url)
    if redirected:
        return redirected
    return normalized


def _extract_apply_url(session, soup, page_url, existing_apply_url=None):
    for selector in APPLY_LINK_SELECTORS:
        for node in soup.select(selector):
            href = normalize_optional_str(node.get("href"))
            label = _normalize_text(node.get_text(" ", strip=True)) or ""
            if not href or not APPLY_TEXT_RE.search(label):
                continue

            resolved = _resolve_candidate_apply_url(session, urljoin(page_url, href))
            host = (urlparse(resolved).netloc or "").lower() if resolved else ""
            if resolved and host and "indeed." not in host:
                return resolved

    existing = normalize_apply_url(existing_apply_url)
    if existing:
        host = (urlparse(existing).netloc or "").lower()
        if host and "indeed." not in host:
            return existing
    return None


def _select_best_description(job, soup, job_posting):
    try:
        return _extract_description(soup, job_posting)
    except IndeedEnrichmentError as exc:
        if exc.code != "description_not_found":
            raise

        existing_description = _normalize_text(job.get("description"))
        if _is_usable_description(existing_description):
            return existing_description
        raise


def enrich_indeed_job(job, *, timeout_ms=45000):
    session = _session()
    timeout_seconds = max(1, int(timeout_ms / 1000))
    try:
        response = session.get(job["job_url"], timeout=timeout_seconds, allow_redirects=True)
    except requests.RequestException as exc:
        raise IndeedEnrichmentError("unexpected_error", f"Could not load the Indeed job page: {exc}") from exc

    if response.status_code == 404:
        raise IndeedEnrichmentError("job_removed", "Indeed indicates the job is no longer available.")

    body_text = _normalize_text(response.text) or ""
    if _detect_rate_limited(response, body_text):
        raise IndeedEnrichmentError("rate_limited", "Indeed appears to be rate-limiting or challenging requests.")
    if _detect_job_removed(body_text):
        raise IndeedEnrichmentError("job_removed", "Indeed indicates the job is no longer available.")

    soup = BeautifulSoup(response.text, "html.parser")
    job_posting = _find_job_posting_json(soup)
    description = _select_best_description(job, soup, job_posting)
    apply_url = _extract_apply_url(session, soup, response.url, existing_apply_url=job.get("apply_url"))
    apply_host = get_apply_host(apply_url)
    ats_type = detect_ats_type(apply_url)
    apply_type = "external_apply" if apply_url else "unknown"
    auto_apply_eligible = 1 if apply_type == "external_apply" else None

    return {
        "description": description,
        "apply_url": apply_url,
        "apply_type": apply_type,
        "auto_apply_eligible": auto_apply_eligible,
        "apply_host": apply_host,
        "ats_type": ats_type,
    }


def _format_error_message(error):
    if isinstance(error, IndeedEnrichmentError):
        return f"{error.code}: {error.message}"
    return f"unexpected_error: {error}"


def _process_claimed_job(claimed_job, *, timeout_ms=45000):
    started_at = time.monotonic()
    print(
        f"[indeed] Claimed job id={claimed_job['id']} "
        f"company={claimed_job.get('company')} title={claimed_job.get('title')}"
    )
    try:
        result = enrich_indeed_job(claimed_job, timeout_ms=timeout_ms)
        mark_job_enrichment_succeeded(
            claimed_job["id"],
            description=result["description"],
            apply_type=result["apply_type"],
            auto_apply_eligible=result["auto_apply_eligible"],
            apply_url=result["apply_url"],
            apply_host=result["apply_host"],
            ats_type=result["ats_type"],
            enrichment_status="done",
            source=SOURCE,
        )
        updated_job = get_job_by_id(claimed_job["id"])
        elapsed_seconds = time.monotonic() - started_at
        print("[indeed] Success")
        print(f"  id: {updated_job['id']}")
        print(f"  apply_type: {updated_job['apply_type']}")
        print(f"  apply_url: {updated_job['apply_url']}")
        print(f"  apply_host: {updated_job['apply_host']}")
        print(f"  ats_type: {updated_job['ats_type']}")
        print(f"  enrichment_status: {updated_job['enrichment_status']}")
        print(f"  elapsed_seconds: {elapsed_seconds:.1f}")
        return {
            "status": "success",
            "job_id": claimed_job["id"],
            "duration_seconds": elapsed_seconds,
        }
    except Exception as exc:
        error_message = _format_error_message(exc)
        error_code = error_message.split(":", 1)[0].strip()
        retry_after = compute_retry_after(error_code, claimed_job.get("enrichment_attempts"))
        next_retry_at = format_sqlite_timestamp(retry_after) if retry_after else None
        mark_job_enrichment_failed(
            claimed_job["id"],
            error_message,
            enrichment_status="failed",
            next_enrichment_retry_at=next_retry_at,
            source=SOURCE,
        )
        elapsed_seconds = time.monotonic() - started_at
        print("[indeed] Failed")
        print(f"  id: {claimed_job['id']}")
        print(f"  error: {error_message}")
        if next_retry_at:
            print(f"  next_retry_at: {next_retry_at}")
        print(f"  elapsed_seconds: {elapsed_seconds:.1f}")
        return {
            "status": "failed",
            "job_id": claimed_job["id"],
            "error": error_message,
            "error_code": error_code,
            "duration_seconds": elapsed_seconds,
        }


def process_batch(*, limit, timeout_ms=45000, return_summary=False):
    started_at = time.monotonic()
    results = []

    for index in range(limit):
        claimed_job = claim_job_for_enrichment(sources=(SOURCE,))
        if not claimed_job:
            print(f"[indeed-batch] No more pending Indeed rows after {index} job(s).")
            break

        print(f"\n[indeed-batch] Processing job {index + 1}/{limit}")
        results.append(_process_claimed_job(claimed_job, timeout_ms=timeout_ms))

    total_elapsed = time.monotonic() - started_at
    successes = [result for result in results if result["status"] == "success"]
    failures = [result for result in results if result["status"] == "failed"]
    failure_breakdown = {}
    for failure in failures:
        failure_breakdown[failure["error_code"]] = failure_breakdown.get(failure["error_code"], 0) + 1

    print("\n[indeed-batch] Summary")
    print(f"  attempted: {len(results)}")
    print(f"  succeeded: {len(successes)}")
    print(f"  failed: {len(failures)}")
    print(f"  total_elapsed_seconds: {total_elapsed:.1f}")
    if results:
        avg_seconds = sum(result["duration_seconds"] for result in results) / len(results)
        print(f"  average_seconds_per_job: {avg_seconds:.1f}")
    if failure_breakdown:
        print("  failure_breakdown:")
        for error_code, count in sorted(failure_breakdown.items()):
            print(f"    {error_code}: {count}")

    exit_code = 0 if not failures else 1
    if return_summary:
        return {
            "exit_code": exit_code,
            "attempted": len(results),
            "ui_verified": 0,
            "succeeded": len(successes),
            "failed": len(failures),
            "actionable_failed": len(failures),
            "failure_breakdown": failure_breakdown,
            "total_elapsed_seconds": total_elapsed,
            "average_seconds_per_job": (
                sum(result["duration_seconds"] for result in results) / len(results)
                if results
                else 0.0
            ),
            "stop_error_code": None,
        }
    return exit_code


def process_one_job(job_id=None, *, timeout_ms=45000, force=False):
    claimed_job = claim_job_for_enrichment(job_id=job_id, force=force, sources=(SOURCE,))
    if not claimed_job:
        if job_id is None:
            print("No pending Indeed rows are ready for enrichment.")
        else:
            print(f"Could not claim Indeed job id={job_id} for enrichment.")
        return 1

    result = _process_claimed_job(claimed_job, timeout_ms=timeout_ms)
    return 0 if result["status"] == "success" else 1


def main():
    parser = argparse.ArgumentParser(description="Enrich Indeed jobs using the shared Stage 3 queue model.")
    parser.add_argument("--job-id", type=int, help="Specific Indeed job id to enrich.")
    parser.add_argument("--timeout-ms", type=int, default=45000)
    parser.add_argument("--limit", type=int, default=1)
    parser.add_argument("--force", action="store_true", help="Allow enriching a specific row even if it is not pending.")
    args = parser.parse_args()

    if args.force and args.job_id is None:
        parser.error("--force requires --job-id")
    if args.job_id is not None and args.limit != 1:
        parser.error("--limit cannot be used with --job-id")
    if args.limit < 1:
        parser.error("--limit must be at least 1")

    if args.limit > 1:
        return process_batch(limit=args.limit, timeout_ms=args.timeout_ms)

    return process_one_job(job_id=args.job_id, timeout_ms=args.timeout_ms, force=args.force)


if __name__ == "__main__":
    raise SystemExit(main())
