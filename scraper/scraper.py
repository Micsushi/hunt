import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from concurrent.futures import ThreadPoolExecutor, as_completed

from config import (
    ENRICH_AFTER_SCRAPE,
    ENRICHMENT_BATCH_LIMIT,
    ENRICHMENT_HEADFUL,
    ENRICHMENT_SLOW_MO_MS,
    ENRICHMENT_TIMEOUT_MS,
    ENRICHMENT_UI_VERIFY_BLOCKED,
    HOURS_OLD,
    LOCATIONS,
    MAX_WORKERS,
    RESULTS_WANTED,
    REVIEW_APP_PUBLIC_URL,
    SEARCH_TERMS,
    SITES,
    TITLE_BLACKLIST,
    WATCHLIST,
)
from db import add_job, count_ready_jobs_for_enrichment, init_db
from notifications import send_discord_webhook_message
from indeed_filters import matches_indeed_category
from jobspy import scrape_jobs
from url_utils import detect_ats_type, get_apply_host, normalize_optional_str


def classify_level(title):
    if not title or not isinstance(title, str):
        return "unknown"

    title_lower = title.lower()

    if any(word in title_lower for word in ["intern", "student", "co-op", "coop", "internship"]):
        return "intern"

    if any(word in title_lower for word in ["new grad", "new graduate", "entry level", "entry-level", "graduate"]):
        return "new_grad"

    if any(
        word in title_lower
        for word in ["junior", "associate", "jr.", "jr ", "engineer i", "developer i", "level 1", "l1"]
    ):
        return "junior"

    return "unknown"


def is_priority(company):
    if not company or not isinstance(company, str):
        return False
    company_lower = company.lower()
    return any(w in company_lower for w in WATCHLIST)


def should_skip(title):
    if not title or not isinstance(title, str):
        return False
    title_lower = title.lower()
    return any(word in title_lower for word in TITLE_BLACKLIST)


def build_job_urls(row, source):
    listing_url = normalize_optional_str(row.get("job_url"))
    direct_url = normalize_optional_str(row.get("job_url_direct"))

    if source == "linkedin":
        return listing_url, direct_url

    return listing_url, direct_url or listing_url


def build_enrichment_fields(source):
    if source not in {"linkedin", "indeed"}:
        return None, None, None

    # Discovery may retain a best-known outbound URL hint, but supported
    # board rows still enter the enrichment queue so Stage 3+ workers can
    # verify descriptions and application targets consistently.
    return "unknown", None, "pending"


def _notify_priority_job(job_id, job_data):
    title = job_data.get("title") or "Unknown title"
    company = job_data.get("company") or "Unknown company"
    url = f"{REVIEW_APP_PUBLIC_URL.rstrip('/')}/jobs/{job_id}"
    send_discord_webhook_message(
        f"Priority job: {title} at {company}\n{url}"
    )


def scrape_single(site, term, location, category):
    print(f"  [{site}] [{category}] Searching: '{term}' in '{location}'...")
    try:
        jobs_df = scrape_jobs(
            site_name=[site],
            search_term=term,
            location=location,
            results_wanted=RESULTS_WANTED,
            hours_old=HOURS_OLD,
            country_indeed="Canada",
        )
    except Exception as e:
        print(f"  [{site}] [{category}] Error for '{term}' in '{location}': {e}")
        return []

    print(f"  [{site}] [{category}] Found {len(jobs_df)} jobs for '{term}' in '{location}'")

    jobs = []
    for _, row in jobs_df.iterrows():
        title = normalize_optional_str(row.get("title"))
        source = normalize_optional_str(row.get("site")) or site

        if should_skip(title):
            continue

        if not title:
            continue

        if source == "indeed" and not matches_indeed_category(title, category):
            continue

        job_url, apply_url = build_job_urls(row, source)
        description = normalize_optional_str(row.get("description"))
        apply_type, auto_apply_eligible, enrichment_status = build_enrichment_fields(source)

        job_data = {
            "title": title,
            "company": normalize_optional_str(row.get("company")),
            "location": normalize_optional_str(row.get("location")),
            "job_url": job_url,
            "apply_url": apply_url,
            "description": description,
            "source": source,
            "date_posted": normalize_optional_str(row.get("date_posted")),
            "is_remote": row.get("is_remote"),
            "level": classify_level(title),
            "priority": is_priority(row.get("company")),
            "category": category,
            "apply_type": apply_type,
            "auto_apply_eligible": auto_apply_eligible,
            "enrichment_status": enrichment_status,
            "enrichment_attempts": 0,
            "apply_host": get_apply_host(apply_url),
            "ats_type": detect_ats_type(apply_url),
        }
        if job_data["job_url"]:
            jobs.append(job_data)
    return jobs


def run_pending_job_enrichment(
    *,
    limit,
    storage_state_path=None,
    headless=True,
    slow_mo=0,
    timeout_ms=45000,
    browser_channel=None,
    ui_verify_blocked=False,
):
    ready_count = count_ready_jobs_for_enrichment()
    if ready_count == 0:
        print("[scrape] No supported rows are ready for enrichment after discovery.")
        return 0

    if limit is None:
        effective_limit = ready_count
    else:
        effective_limit = max(0, min(limit, ready_count))

    if effective_limit == 0:
        print("[scrape] Post-scrape LinkedIn enrichment is enabled, but the configured limit is 0.")
        return 0

    print(
        f"[scrape] Starting post-scrape enrichment for up to {effective_limit} "
        f"ready row(s) out of {ready_count}."
    )

    try:
        from enrich_jobs import process_multi_source_batch

        return process_multi_source_batch(
            limit=effective_limit,
            storage_state_path=storage_state_path,
            headless=headless,
            slow_mo=slow_mo,
            timeout_ms=timeout_ms,
            browser_channel=browser_channel,
            ui_verify_blocked=ui_verify_blocked,
        )
    except Exception as exc:
        print(f"[scrape] Post-scrape enrichment could not start: {exc}")
        return 1


def run_pending_linkedin_enrichment(
    *,
    limit,
    storage_state_path=None,
    headless=True,
    slow_mo=0,
    timeout_ms=45000,
    browser_channel=None,
    ui_verify_blocked=False,
):
    return run_pending_job_enrichment(
        limit=limit,
        storage_state_path=storage_state_path,
        headless=headless,
        slow_mo=slow_mo,
        timeout_ms=timeout_ms,
        browser_channel=browser_channel,
        ui_verify_blocked=ui_verify_blocked,
    )


def scrape(
    *,
    enrich_pending=None,
    enrich_limit=None,
    storage_state_path=None,
    enrichment_headless=None,
    enrichment_slow_mo=None,
    enrichment_timeout_ms=None,
    enrichment_browser_channel=None,
    ui_verify_blocked=None,
):
    init_db()

    if enrich_pending is None:
        enrich_pending = ENRICH_AFTER_SCRAPE
    if enrich_limit is None:
        enrich_limit = ENRICHMENT_BATCH_LIMIT
    if enrichment_headless is None:
        enrichment_headless = not ENRICHMENT_HEADFUL
    if enrichment_slow_mo is None:
        enrichment_slow_mo = ENRICHMENT_SLOW_MO_MS
    if enrichment_timeout_ms is None:
        enrichment_timeout_ms = ENRICHMENT_TIMEOUT_MS
    if ui_verify_blocked is None:
        ui_verify_blocked = ENRICHMENT_UI_VERIFY_BLOCKED

    all_jobs = []
    tasks = [
        (site, term, location, category)
        for category, terms in SEARCH_TERMS.items()
        for term in terms
        for location in LOCATIONS
        for site in SITES
    ]

    print(f"Starting {len(tasks)} scrape tasks with {MAX_WORKERS} workers...\n")

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {
            executor.submit(scrape_single, site, term, location, category): (site, term, location, category)
            for site, term, location, category in tasks
        }

        for future in as_completed(futures):
            jobs = future.result()
            all_jobs.extend(jobs)

    inserted = 0
    refreshed = 0
    for job_data in all_jobs:
        add_result = add_job(job_data)
        result = add_result[0]
        job_id = add_result[1]
        if result == "inserted":
            inserted += 1
            if job_data.get("priority"):
                _notify_priority_job(job_id, job_data)
        elif result == "updated":
            refreshed += 1
            priority_changed = len(add_result) > 2 and add_result[2]
            if priority_changed:
                _notify_priority_job(job_id, job_data)

    skipped = len(all_jobs) - inserted - refreshed
    print(
        f"\nDone! Scraped {len(all_jobs)} total jobs, added {inserted} new to database, "
        f"refreshed {refreshed} existing row(s), skipped {skipped} unchanged duplicate(s)"
    )

    enrichment_exit_code = None
    if enrich_pending:
        enrichment_exit_code = run_pending_linkedin_enrichment(
            limit=enrich_limit,
            storage_state_path=storage_state_path,
            headless=enrichment_headless,
            slow_mo=enrichment_slow_mo,
            timeout_ms=enrichment_timeout_ms,
            browser_channel=enrichment_browser_channel,
            ui_verify_blocked=ui_verify_blocked,
        )
        if enrichment_exit_code == 0:
            print("[scrape] Post-scrape enrichment finished cleanly.")
        else:
            print("[scrape] Post-scrape enrichment finished with some unresolved failures.")

    return {
        "scraped_total": len(all_jobs),
        "inserted": inserted,
        "refreshed": refreshed,
        "skipped": skipped,
        "enrichment_exit_code": enrichment_exit_code,
    }


if __name__ == "__main__":
    import time

    parser = argparse.ArgumentParser(description="Run discovery scraping and optionally enrich pending LinkedIn rows.")
    enrichment_toggle = parser.add_mutually_exclusive_group()
    enrichment_toggle.add_argument(
        "--enrich-pending",
        action="store_true",
        help="Run a post-scrape LinkedIn enrichment pass after discovery.",
    )
    enrichment_toggle.add_argument(
        "--skip-enrichment",
        action="store_true",
        help="Skip the post-scrape LinkedIn enrichment pass for this run.",
    )
    parser.add_argument(
        "--enrich-limit",
        type=int,
        help=f"Maximum number of pending LinkedIn rows to enrich after discovery (default: {ENRICHMENT_BATCH_LIMIT}).",
    )
    parser.add_argument(
        "--storage-state",
        help="Optional Playwright storage-state path for LinkedIn enrichment.",
    )
    parser.add_argument(
        "--headful",
        action="store_true",
        help="Run the post-scrape LinkedIn enrichment browser visibly.",
    )
    parser.add_argument(
        "--slow-mo",
        type=int,
        help=f"Optional Playwright slow_mo for post-scrape enrichment (default: {ENRICHMENT_SLOW_MO_MS}).",
    )
    parser.add_argument(
        "--timeout-ms",
        type=int,
        help=f"Navigation/action timeout for post-scrape enrichment (default: {ENRICHMENT_TIMEOUT_MS}).",
    )
    parser.add_argument(
        "--channel",
        help="Optional Playwright browser channel such as chrome or msedge for post-scrape enrichment.",
    )
    parser.add_argument(
        "--ui-verify-blocked",
        action="store_true",
        help="After the normal post-scrape pass, rerun blocked rows in a visible browser.",
    )
    args = parser.parse_args()

    enrich_pending = ENRICH_AFTER_SCRAPE
    if args.enrich_pending:
        enrich_pending = True
    elif args.skip_enrichment:
        enrich_pending = False

    start = time.time()
    scrape(
        enrich_pending=enrich_pending,
        enrich_limit=args.enrich_limit,
        storage_state_path=args.storage_state,
        enrichment_headless=not args.headful if args.headful else None,
        enrichment_slow_mo=args.slow_mo,
        enrichment_timeout_ms=args.timeout_ms,
        enrichment_browser_channel=args.channel,
        ui_verify_blocked=args.ui_verify_blocked if args.ui_verify_blocked else None,
    )
    elapsed = time.time() - start
    minutes, seconds = divmod(int(elapsed), 60)
    print(f"Completed in {minutes}m {seconds}s")
