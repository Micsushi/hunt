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

from browser_runtime import BrowserRuntimeError, PlaywrightTimeoutError, open_browser_context  # noqa: E402
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
DEFAULT_BROWSER_CHANNEL = os.getenv("INDEED_BROWSER_CHANNEL") or os.getenv("LINKEDIN_BROWSER_CHANNEL") or None
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
UI_VERIFIABLE_ERROR_CODES = {"description_not_found", "rate_limited", "unexpected_error"}
SUCCESS_STATUS_UI_VERIFIED = "done_verified"
FAILURE_STATUS_BLOCKED_UI_VERIFIED = "blocked_verified"


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


def _resolve_candidate_apply_url_in_browser(page, candidate_url):
    normalized = normalize_apply_url(candidate_url)
    if not normalized:
        return None

    host = (urlparse(normalized).netloc or "").lower()
    if host and "indeed." not in host:
        return normalized

    popup = None
    original_page = page
    try:
        try:
            with page.context.expect_page(timeout=1500) as popup_info:
                page.goto(normalized, wait_until="domcontentloaded", timeout=15000)
            popup = popup_info.value
        except Exception:
            page.goto(normalized, wait_until="domcontentloaded", timeout=15000)
        target = popup or original_page
        redirected = normalize_apply_url(target.url)
        if redirected:
            return redirected
    except Exception:
        return normalized
    finally:
        if popup:
            try:
                popup.close()
            except Exception:
                pass
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


def _detect_apply_url_from_browser(page, page_url, existing_apply_url=None):
    try:
        anchors = page.locator("a[href]")
        count = min(anchors.count(), 100)
    except Exception:
        count = 0

    for index in range(count):
        try:
            node = anchors.nth(index)
            href = normalize_optional_str(node.get_attribute("href"))
            label = _normalize_text(node.inner_text()) or ""
        except Exception:
            continue
        if not href or not APPLY_TEXT_RE.search(label):
            continue

        resolved = _resolve_candidate_apply_url_in_browser(page, urljoin(page_url, href))
        host = (urlparse(resolved).netloc or "").lower() if resolved else ""
        if resolved and host and "indeed." not in host:
            return resolved

    existing = normalize_apply_url(existing_apply_url)
    if existing:
        host = (urlparse(existing).netloc or "").lower()
        if host and "indeed." not in host:
            return existing
    return None


def _extract_description_from_browser(page, job):
    for selector in DESCRIPTION_SELECTORS:
        try:
            locator = page.locator(selector)
            if locator.count() <= 0:
                continue
            description = _normalize_text(locator.first.inner_text(timeout=2500))
            if _is_usable_description(description):
                return description
        except Exception:
            continue

    existing_description = _normalize_text(job.get("description"))
    if _is_usable_description(existing_description):
        return existing_description

    raise IndeedEnrichmentError(
        "description_not_found",
        "Could not extract a usable description from the Indeed job page.",
    )


def enrich_indeed_job_in_context(context, job, *, timeout_ms=45000):
    page = context.new_page()
    timeout_ms = max(1000, int(timeout_ms))
    try:
        page.goto(job["job_url"], wait_until="domcontentloaded", timeout=timeout_ms)
        try:
            page.wait_for_load_state("networkidle", timeout=min(timeout_ms, 4000))
        except PlaywrightTimeoutError:
            pass

        body_text = _normalize_text(page.locator("body").inner_text(timeout=2000)) or ""
        if _detect_job_removed(body_text):
            raise IndeedEnrichmentError("job_removed", "Indeed indicates the job is no longer available.")
        if any(pattern in body_text.lower() for pattern in RATE_LIMIT_PATTERNS):
            raise IndeedEnrichmentError("rate_limited", "Indeed appears to be rate-limiting or challenging requests.")

        description = _extract_description_from_browser(page, job)
        apply_url = _detect_apply_url_from_browser(page, page.url, existing_apply_url=job.get("apply_url"))
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
    finally:
        try:
            page.close()
        except Exception:
            pass


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
    if isinstance(error, BrowserRuntimeError):
        return f"browser_unavailable: {error}"
    return f"unexpected_error: {error}"


def _get_success_enrichment_status(*, ui_verify=False):
    return SUCCESS_STATUS_UI_VERIFIED if ui_verify else "done"


def _get_failure_enrichment_status(error_code, *, ui_verify=False):
    if error_code in UI_VERIFIABLE_ERROR_CODES:
        return FAILURE_STATUS_BLOCKED_UI_VERIFIED if ui_verify else "blocked"
    return "failed"


def _should_stop_batch_after_failure(error_code, *, ui_verify_blocked=False):
    if error_code == "browser_unavailable":
        return True
    if error_code in UI_VERIFIABLE_ERROR_CODES:
        return not ui_verify_blocked
    return False


def _is_non_actionable_failure_code(error_code):
    return error_code == "job_removed"


def _process_claimed_job(claimed_job, *, timeout_ms=45000, context=None, ui_verify=False):
    started_at = time.monotonic()
    print(
        f"[indeed] Claimed job id={claimed_job['id']} "
        f"company={claimed_job.get('company')} title={claimed_job.get('title')}"
    )
    try:
        if context is not None:
            result = enrich_indeed_job_in_context(context, claimed_job, timeout_ms=timeout_ms)
        else:
            result = enrich_indeed_job(claimed_job, timeout_ms=timeout_ms)
        mark_job_enrichment_succeeded(
            claimed_job["id"],
            description=result["description"],
            apply_type=result["apply_type"],
            auto_apply_eligible=result["auto_apply_eligible"],
            apply_url=result["apply_url"],
            apply_host=result["apply_host"],
            ats_type=result["ats_type"],
            enrichment_status=_get_success_enrichment_status(ui_verify=ui_verify),
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
        next_retry_at = None if ui_verify else (format_sqlite_timestamp(retry_after) if retry_after else None)
        mark_job_enrichment_failed(
            claimed_job["id"],
            error_message,
            enrichment_status=_get_failure_enrichment_status(error_code, ui_verify=ui_verify),
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


def process_batch(*, limit, timeout_ms=45000, browser_channel=None, ui_verify_blocked=False, return_summary=False):
    started_at = time.monotonic()
    results = []
    final_results_by_job_id = {}
    blocked_job_ids = []

    for index in range(limit):
        claimed_job = claim_job_for_enrichment(sources=(SOURCE,))
        if not claimed_job:
            print(f"[indeed-batch] No more pending Indeed rows after {index} job(s).")
            break

        print(f"\n[indeed-batch] Processing job {index + 1}/{limit}")
        result = _process_claimed_job(claimed_job, timeout_ms=timeout_ms)
        results.append(result)
        final_results_by_job_id[result["job_id"]] = result

        if result["status"] == "failed":
            error_code = result.get("error_code")
            if ui_verify_blocked and error_code in UI_VERIFIABLE_ERROR_CODES:
                blocked_job_ids.append(result["job_id"])
                print(f"[indeed-batch] Queued blocked job id={result['job_id']} for browser verification after the first pass.")
                continue
            if _should_stop_batch_after_failure(error_code, ui_verify_blocked=ui_verify_blocked):
                print(f"[indeed-batch] Stopping early because of blocking error: {error_code}")
                break

    ui_verify_results = []
    if ui_verify_blocked and blocked_job_ids:
        print(f"\n[indeed-batch] Starting browser verification for {len(blocked_job_ids)} blocked job(s).")
        with open_browser_context(
            headless=False,
            slow_mo=0,
            browser_channel=browser_channel or DEFAULT_BROWSER_CHANNEL,
        ) as ui_context:
            for index, job_id in enumerate(blocked_job_ids, start=1):
                claimed_job = claim_job_for_enrichment(job_id=job_id, force=True, sources=(SOURCE,))
                if not claimed_job:
                    result = {
                        "status": "failed",
                        "job_id": job_id,
                        "error": "claim_failed: could not reclaim blocked job for UI verification",
                        "error_code": "claim_failed",
                        "duration_seconds": 0.0,
                    }
                else:
                    print(f"\n[indeed-batch-ui] Verifying blocked job {index}/{len(blocked_job_ids)}")
                    result = _process_claimed_job(
                        claimed_job,
                        timeout_ms=timeout_ms,
                        context=ui_context,
                        ui_verify=True,
                    )
                ui_verify_results.append(result)
                final_results_by_job_id[result["job_id"]] = result
                if result["status"] == "failed" and _should_stop_batch_after_failure(result.get("error_code"), ui_verify_blocked=False):
                    print(f"[indeed-batch-ui] Stopping early because of blocking error: {result['error_code']}")
                    break

    total_elapsed = time.monotonic() - started_at
    final_results = list(final_results_by_job_id.values()) or results
    successes = [result for result in final_results if result["status"] == "success"]
    failures = [result for result in final_results if result["status"] == "failed"]
    actionable_failures = [result for result in failures if not _is_non_actionable_failure_code(result.get("error_code"))]
    failure_breakdown = {}
    for failure in failures:
        failure_breakdown[failure["error_code"]] = failure_breakdown.get(failure["error_code"], 0) + 1

    print("\n[indeed-batch] Summary")
    print(f"  attempted: {len(results)}")
    if ui_verify_results:
        print(f"  ui_verified: {len(ui_verify_results)}")
    print(f"  succeeded: {len(successes)}")
    print(f"  failed: {len(failures)}")
    print(f"  total_elapsed_seconds: {total_elapsed:.1f}")
    all_timed_results = results + ui_verify_results
    if all_timed_results:
        avg_seconds = sum(result["duration_seconds"] for result in all_timed_results) / len(all_timed_results)
        print(f"  average_seconds_per_job: {avg_seconds:.1f}")
    if failure_breakdown:
        print("  failure_breakdown:")
        for error_code, count in sorted(failure_breakdown.items()):
            print(f"    {error_code}: {count}")

    stop_error_code = None
    for failure in failures:
        error_code = failure.get("error_code")
        if _should_stop_batch_after_failure(error_code, ui_verify_blocked=False):
            stop_error_code = error_code
            break

    exit_code = 0 if not actionable_failures else 1
    if return_summary:
        return {
            "exit_code": exit_code,
            "attempted": len(results),
            "ui_verified": len(ui_verify_results),
            "succeeded": len(successes),
            "failed": len(failures),
            "actionable_failed": len(actionable_failures),
            "failure_breakdown": failure_breakdown,
            "total_elapsed_seconds": total_elapsed,
            "average_seconds_per_job": (
                sum(result["duration_seconds"] for result in all_timed_results) / len(all_timed_results)
                if all_timed_results
                else 0.0
            ),
            "stop_error_code": stop_error_code,
        }
    return exit_code


def process_one_job(job_id=None, *, timeout_ms=45000, force=False, browser_channel=None, ui_verify=False):
    claimed_job = claim_job_for_enrichment(job_id=job_id, force=force, sources=(SOURCE,))
    if not claimed_job:
        if job_id is None:
            print("No pending Indeed rows are ready for enrichment.")
        else:
            print(f"Could not claim Indeed job id={job_id} for enrichment.")
        return 1

    if ui_verify:
        try:
            with open_browser_context(
                headless=False,
                slow_mo=0,
                browser_channel=browser_channel or DEFAULT_BROWSER_CHANNEL,
            ) as context:
                result = _process_claimed_job(
                    claimed_job,
                    timeout_ms=timeout_ms,
                    context=context,
                    ui_verify=True,
                )
        except Exception as exc:
            error_message = _format_error_message(exc)
            error_code = error_message.split(":", 1)[0].strip()
            mark_job_enrichment_failed(
                claimed_job["id"],
                error_message,
                enrichment_status=_get_failure_enrichment_status(error_code, ui_verify=True),
                next_enrichment_retry_at=None,
                source=SOURCE,
            )
            print("[indeed] Failed")
            print(f"  id: {claimed_job['id']}")
            print(f"  error: {error_message}")
            return 1
    else:
        result = _process_claimed_job(claimed_job, timeout_ms=timeout_ms)
    return 0 if result["status"] == "success" else 1


def main():
    parser = argparse.ArgumentParser(description="Enrich Indeed jobs using the shared Stage 3 queue model.")
    parser.add_argument("--job-id", type=int, help="Specific Indeed job id to enrich.")
    parser.add_argument("--timeout-ms", type=int, default=45000)
    parser.add_argument("--limit", type=int, default=1)
    parser.add_argument("--force", action="store_true", help="Allow enriching a specific row even if it is not pending.")
    parser.add_argument("--channel", help="Optional Playwright browser channel such as chrome.")
    parser.add_argument("--ui-verify", action="store_true", help="Re-run one specific Indeed row in a visible browser.")
    parser.add_argument("--ui-verify-blocked", action="store_true", help="For batch runs, rerun browser-verifiable Indeed rows in a visible browser after the first pass.")
    args = parser.parse_args()

    if args.force and args.job_id is None:
        parser.error("--force requires --job-id")
    if args.job_id is not None and args.limit != 1:
        parser.error("--limit cannot be used with --job-id")
    if args.limit < 1:
        parser.error("--limit must be at least 1")
    if args.ui_verify and args.job_id is None:
        parser.error("--ui-verify requires --job-id")
    if args.ui_verify and args.limit != 1:
        parser.error("--ui-verify cannot be used with --limit")
    if args.ui_verify_blocked and args.limit == 1:
        parser.error("--ui-verify-blocked requires --limit greater than 1")
    if args.ui_verify_blocked and args.job_id is not None:
        parser.error("--ui-verify-blocked cannot be used with --job-id")

    if args.limit > 1:
        return process_batch(
            limit=args.limit,
            timeout_ms=args.timeout_ms,
            browser_channel=args.channel,
            ui_verify_blocked=args.ui_verify_blocked,
        )

    return process_one_job(
        job_id=args.job_id,
        timeout_ms=args.timeout_ms,
        force=args.force,
        browser_channel=args.channel,
        ui_verify=args.ui_verify,
    )


if __name__ == "__main__":
    raise SystemExit(main())
