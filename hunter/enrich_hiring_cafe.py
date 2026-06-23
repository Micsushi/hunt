import argparse
import os
import random
import re
import sys
import time

import requests

if __package__ is None or __package__ == "":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from hunter.c1_logging import C1Logger  # noqa: E402
from hunter.db import (  # noqa: E402
    claim_linkedin_job_for_hiring_cafe_fallback,
    get_job_by_id,
    mark_job_enrichment_failed,
    mark_job_enrichment_succeeded,
)
from hunter.enrichment_policy import (  # noqa: E402
    compute_retry_after,
    format_sqlite_timestamp,
    is_retryable_error_code,
)
from hunter.providers import hiring_cafe  # noqa: E402
from hunter.url_utils import (  # noqa: E402
    detect_ats_type,
    get_apply_host,
    looks_like_linkedin_url,
    normalize_apply_url,
    normalize_optional_str,
)

SOURCE = "linkedin"
PROVIDER = "hiring_cafe"
DEFAULT_SEARCH_DAYS = int(os.getenv("HIRING_CAFE_SEARCH_DAYS", "365"))
DEFAULT_SEARCH_LIMIT = int(os.getenv("HIRING_CAFE_SEARCH_LIMIT", "3"))
DEFAULT_MIN_SCORE = float(os.getenv("HIRING_CAFE_MIN_MATCH_SCORE", "0.62"))
DEFAULT_SLEEP_MIN_SECONDS = float(os.getenv("HIRING_CAFE_SLEEP_MIN_SECONDS", "20"))
DEFAULT_SLEEP_MAX_SECONDS = float(os.getenv("HIRING_CAFE_SLEEP_MAX_SECONDS", "60"))
MIN_DESCRIPTION_LENGTH = 50


class HiringCafeEnrichmentError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _normalize_text(value):
    normalized = normalize_optional_str(value)
    if not normalized:
        return None
    normalized = re.sub(r"\r\n?", "\n", normalized)
    lines = [re.sub(r"\s+", " ", line).strip() for line in normalized.splitlines()]
    cleaned = "\n".join(line for line in lines if line)
    return cleaned or None


def _tokens(value):
    normalized = normalize_optional_str(value)
    if not normalized:
        return set()
    return {
        token
        for token in re.findall(r"[a-z0-9]+", normalized.lower())
        if len(token) > 1 and token not in {"the", "and", "inc", "ltd", "corp", "company"}
    }


def _overlap_score(left, right):
    left_tokens = _tokens(left)
    right_tokens = _tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens)


def _jaccard_score(left, right):
    left_tokens = _tokens(left)
    right_tokens = _tokens(right)
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / len(left_tokens | right_tokens)


def _is_usable_description(value, *, minimum_length=MIN_DESCRIPTION_LENGTH):
    normalized = _normalize_text(value)
    return bool(normalized and len(normalized) >= minimum_length)


def _build_query(job):
    title = normalize_optional_str(job.get("title"))
    company = normalize_optional_str(job.get("company"))
    location = normalize_optional_str(job.get("location"))
    parts = [part for part in (company, title, location) if part]
    return " ".join(parts)


def _score_candidate(job, candidate):
    title_score = _overlap_score(job.get("title"), candidate.title)
    company_score = _overlap_score(job.get("company"), candidate.company)
    location_score = _overlap_score(job.get("location"), candidate.location)

    score = (title_score * 0.62) + (company_score * 0.33) + (location_score * 0.05)
    if normalize_optional_str(job.get("company")) and company_score <= 0:
        score -= 0.25
    if normalize_optional_str(job.get("title")) and title_score < 0.4:
        score -= 0.2
    return max(0.0, min(1.0, score))


def _has_acceptable_title_match(job, candidate):
    title_tokens = _tokens(job.get("title"))
    if not title_tokens:
        return True

    title_jaccard = _jaccard_score(job.get("title"), candidate.title)
    if len(title_tokens) <= 2:
        return title_jaccard >= 0.8
    if len(title_tokens) <= 4:
        return title_jaccard >= 0.55
    return title_jaccard >= 0.35 or _overlap_score(job.get("title"), candidate.title) >= 0.65


def _select_best_candidate(job, candidates, *, min_score=DEFAULT_MIN_SCORE):
    scored = []
    for candidate in candidates:
        apply_url = normalize_apply_url(candidate.apply_url)
        if not apply_url or looks_like_linkedin_url(apply_url):
            continue
        if not _has_acceptable_title_match(job, candidate):
            continue
        score = _score_candidate(job, candidate)
        if score >= min_score:
            scored.append((score, candidate, apply_url))

    if not scored:
        return None
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0]


def enrich_linkedin_job_with_hiring_cafe(
    job,
    *,
    search_jobs_fn=None,
    fetch_description_html_fn=None,
    days=DEFAULT_SEARCH_DAYS,
    search_limit=DEFAULT_SEARCH_LIMIT,
    min_score=DEFAULT_MIN_SCORE,
):
    query = _build_query(job)
    if not query:
        raise HiringCafeEnrichmentError(
            "hiring_cafe_match_not_found", "Job row does not have enough text to search HiringCafe."
        )

    search_jobs_fn = search_jobs_fn or hiring_cafe.search_jobs
    fetch_description_html_fn = fetch_description_html_fn or hiring_cafe.fetch_description_html
    try:
        candidates = search_jobs_fn(
            query,
            days=days,
            limit=search_limit,
            include_descriptions=False,
        )
    except requests.HTTPError as exc:
        status_code = getattr(exc.response, "status_code", None)
        if status_code in (429, 503):
            raise HiringCafeEnrichmentError(
                "rate_limited", f"HiringCafe rate limited search for {query!r}."
            ) from exc
        raise HiringCafeEnrichmentError(
            "unexpected_error", f"HiringCafe search failed for {query!r}: {exc}"
        ) from exc
    except (requests.RequestException, hiring_cafe.HiringCafeProviderError) as exc:
        raise HiringCafeEnrichmentError(
            "unexpected_error", f"HiringCafe search failed for {query!r}: {exc}"
        ) from exc

    selected = _select_best_candidate(job, candidates, min_score=min_score)
    if not selected:
        raise HiringCafeEnrichmentError(
            "hiring_cafe_match_not_found",
            f"HiringCafe did not return a confident external match for {query!r}.",
        )

    score, candidate, apply_url = selected
    description = _normalize_text(candidate.description)
    if not _is_usable_description(description):
        try:
            description = hiring_cafe.html_to_text(fetch_description_html_fn(candidate.source_id))
        except requests.HTTPError as exc:
            status_code = getattr(exc.response, "status_code", None)
            if status_code in (429, 503):
                raise HiringCafeEnrichmentError(
                    "rate_limited",
                    f"HiringCafe rate limited description fetch for {candidate.source_id!r}.",
                ) from exc
            raise HiringCafeEnrichmentError(
                "unexpected_error",
                f"HiringCafe description fetch failed for {candidate.source_id!r}: {exc}",
            ) from exc
        except (requests.RequestException, hiring_cafe.HiringCafeProviderError) as exc:
            raise HiringCafeEnrichmentError(
                "unexpected_error",
                f"HiringCafe description fetch failed for {candidate.source_id!r}: {exc}",
            ) from exc
    if not _is_usable_description(description):
        raise HiringCafeEnrichmentError(
            "description_not_found",
            f"HiringCafe did not return a usable description for {candidate.source_id!r}.",
        )
    return {
        "description": description,
        "apply_url": apply_url,
        "apply_type": "external_apply",
        "auto_apply_eligible": True,
        "apply_host": get_apply_host(apply_url),
        "ats_type": detect_ats_type(apply_url),
        "provider": PROVIDER,
        "provider_source_id": candidate.source_id,
        "provider_score": score,
    }


def _format_error_message(error):
    if isinstance(error, HiringCafeEnrichmentError):
        return f"{error.code}: {error.message}"
    return f"unexpected_error: {error}"


def _is_non_actionable_failure_code(error_code):
    return error_code == "hiring_cafe_match_not_found"


def _get_failure_enrichment_status(error_code):
    return "failed"


def _should_stop_batch_after_failure(error_code):
    return error_code == "rate_limited"


def _log_retry_exhausted(claimed_job, *, error_code, error_message):
    C1Logger(discord=False).event(
        key="hunt_last_retry_exhausted",
        level="warn",
        message="C1 HiringCafe fallback retries exhausted.",
        code="retry_exhausted",
        details={
            "job_id": claimed_job.get("id"),
            "source": SOURCE,
            "provider": PROVIDER,
            "error_code": error_code,
            "error_message": error_message,
            "enrichment_attempts": claimed_job.get("enrichment_attempts"),
        },
    )


def _process_claimed_job(claimed_job):
    started_at = time.monotonic()
    print(
        f"[hiring-cafe] Claimed LinkedIn fallback job id={claimed_job['id']} "
        f"company={claimed_job.get('company')} title={claimed_job.get('title')}"
    )
    try:
        result = enrich_linkedin_job_with_hiring_cafe(claimed_job)
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
        print("[hiring-cafe] Success")
        print(f"  id: {updated_job['id']}")
        print(f"  apply_url: {updated_job['apply_url']}")
        print(f"  apply_host: {updated_job['apply_host']}")
        print(f"  ats_type: {updated_job['ats_type']}")
        print(f"  provider_score: {result['provider_score']:.2f}")
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
        if is_retryable_error_code(error_code) and retry_after is None:
            _log_retry_exhausted(
                claimed_job,
                error_code=error_code,
                error_message=error_message,
            )
        mark_job_enrichment_failed(
            claimed_job["id"],
            error_message,
            enrichment_status=_get_failure_enrichment_status(error_code),
            next_enrichment_retry_at=next_retry_at,
            source=SOURCE,
        )
        elapsed_seconds = time.monotonic() - started_at
        print("[hiring-cafe] Failed")
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


def _sleep_between_requests():
    sleep_min = max(0.0, DEFAULT_SLEEP_MIN_SECONDS)
    sleep_max = max(sleep_min, DEFAULT_SLEEP_MAX_SECONDS)
    if sleep_max <= 0:
        return
    delay = random.uniform(sleep_min, sleep_max)
    print(f"[hiring-cafe-batch] Sleeping {delay:.1f}s before next request.")
    time.sleep(delay)


def process_batch(*, limit, return_summary=False):
    started_at = time.monotonic()
    results = []

    for index in range(limit):
        claimed_job = claim_linkedin_job_for_hiring_cafe_fallback()
        if not claimed_job:
            print(f"[hiring-cafe-batch] No more fallback-ready LinkedIn rows after {index} job(s).")
            break

        print(f"\n[hiring-cafe-batch] Processing fallback job {index + 1}/{limit}")
        result = _process_claimed_job(claimed_job)
        results.append(result)

        if result["status"] == "failed" and _should_stop_batch_after_failure(
            result.get("error_code")
        ):
            print(
                f"[hiring-cafe-batch] Stopping early because of blocking error: {result['error_code']}"
            )
            break
        if index < limit - 1:
            _sleep_between_requests()

    total_elapsed = time.monotonic() - started_at
    successes = [result for result in results if result["status"] == "success"]
    failures = [result for result in results if result["status"] == "failed"]
    actionable_failures = [
        result
        for result in failures
        if not _is_non_actionable_failure_code(result.get("error_code"))
    ]
    failure_breakdown = {}
    for failure in failures:
        failure_breakdown[failure["error_code"]] = (
            failure_breakdown.get(failure["error_code"], 0) + 1
        )

    print("\n[hiring-cafe-batch] Summary")
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

    stop_error_code = None
    for failure in failures:
        error_code = failure.get("error_code")
        if _should_stop_batch_after_failure(error_code):
            stop_error_code = error_code
            break

    exit_code = 0 if not actionable_failures else 1
    if return_summary:
        return {
            "exit_code": exit_code,
            "attempted": len(results),
            "ui_verified": 0,
            "succeeded": len(successes),
            "failed": len(failures),
            "actionable_failed": len(actionable_failures),
            "failure_breakdown": failure_breakdown,
            "total_elapsed_seconds": total_elapsed,
            "average_seconds_per_job": (
                sum(result["duration_seconds"] for result in results) / len(results)
                if results
                else 0.0
            ),
            "stop_error_code": stop_error_code,
        }
    return exit_code


def process_one_job(job_id=None, *, force=False):
    claimed_job = claim_linkedin_job_for_hiring_cafe_fallback(job_id=job_id, force=force)
    if not claimed_job:
        if job_id is None:
            print("No LinkedIn rows are ready for HiringCafe fallback enrichment.")
        else:
            print(f"Could not claim LinkedIn job id={job_id} for HiringCafe fallback enrichment.")
        return 1

    result = _process_claimed_job(claimed_job)
    return 0 if result["status"] == "success" else 1


def main():
    parser = argparse.ArgumentParser(
        description="Enrich LinkedIn rows through HiringCafe when LinkedIn auth is unavailable."
    )
    parser.add_argument("--job-id", type=int, help="Specific LinkedIn job id to enrich.")
    parser.add_argument("--limit", type=int, default=1)
    parser.add_argument(
        "--force",
        action="store_true",
        help="Allow enriching a specific row even if it is not fallback-ready.",
    )
    args = parser.parse_args()

    if args.force and args.job_id is None:
        parser.error("--force requires --job-id")
    if args.job_id is not None and args.limit != 1:
        parser.error("--limit cannot be used with --job-id")
    if args.limit < 1:
        parser.error("--limit must be at least 1")

    if args.limit > 1:
        return process_batch(limit=args.limit)
    return process_one_job(job_id=args.job_id, force=args.force)


if __name__ == "__main__":
    raise SystemExit(main())
