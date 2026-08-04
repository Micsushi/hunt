"""
C1 (Hunter) discovery entrypoint (CLI).

This file lives inside the **hunter** package; the name **scraper.py** is historical.
See **docs/NAMING.md** for component IDs and code names.
"""

import argparse
import logging
import os
import sys
import threading
from contextlib import ExitStack
from datetime import UTC, datetime, timedelta

if __package__ is None or __package__ == "":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from concurrent.futures import ThreadPoolExecutor, as_completed

from hunter.c1_logging import C1Logger
from hunter.config import (
    ENRICH_AFTER_SCRAPE,
    ENRICHMENT_BATCH_LIMIT,
    ENRICHMENT_HEADFUL,
    ENRICHMENT_SLOW_MO_MS,
    ENRICHMENT_TIMEOUT_MS,
    ENRICHMENT_UI_VERIFY_BLOCKED,
    EXPERIENCE_LEVELS,
    HOURS_OLD,
    LINKEDIN_DISCOVERY_COOLDOWN_MINUTES,
    LINKEDIN_DISCOVERY_MAX_WORKERS,
    LINKEDIN_FETCH_DESCRIPTION,
    LINKEDIN_QUERIES_PER_RUN,
    LINKEDIN_RESULTS_WANTED,
    LOCATIONS,
    MAX_WORKERS,
    RESULTS_WANTED,
    REVIEW_APP_PUBLIC_URL,
    SEARCH_QUERIES,
    SITES,
    TARGET_JOB_TITLES,
    TITLE_BLACKLIST,
    WATCHLIST,
)
from hunter.db import (
    add_job,
    clear_linkedin_discovery_cooldown,
    count_ready_jobs_for_enrichment,
    get_linkedin_discovery_cooldown_until,
    get_linkedin_discovery_query_cursor,
    init_db,
    is_linkedin_discovery_in_cooldown,
    set_linkedin_discovery_cooldown_until,
    set_linkedin_discovery_query_cursor,
)
from hunter.notifications import send_discord_webhook_message
from hunter.search_lanes import title_matches_search_lane, title_matches_target_preferences
from hunter.url_utils import detect_ats_type, get_apply_host, normalize_optional_str

_linkedin_discovery_blocked = threading.Event()
_linkedin_discovery_guard_active = False
_linkedin_query_cursor_lock = threading.Lock()


class _LinkedInRateLimitHandler(logging.Handler):
    def __init__(self, on_rate_limit):
        super().__init__(level=logging.ERROR)
        self._on_rate_limit = on_rate_limit

    def emit(self, record):
        if "429" not in record.getMessage():
            return
        try:
            self._on_rate_limit(record.getMessage())
        except Exception:
            self.handleError(record)


def classify_level(title):
    if not title or not isinstance(title, str):
        return "unknown"

    title_lower = title.lower()

    if any(word in title_lower for word in ["intern", "student", "co-op", "coop", "internship"]):
        return "intern"

    if any(
        word in title_lower
        for word in ["new grad", "new graduate", "entry level", "entry-level", "graduate"]
    ):
        return "new_grad"

    if any(
        word in title_lower
        for word in [
            "junior",
            "associate",
            "jr.",
            "jr ",
            "engineer i",
            "developer i",
            "level 1",
            "l1",
        ]
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


def _record_priority_job(job_id, job_data):
    title = job_data.get("title") or "Unknown title"
    company = job_data.get("company") or "Unknown company"
    url = f"{REVIEW_APP_PUBLIC_URL.rstrip('/')}/jobs/{job_id}"
    logger = C1Logger(discord=True)
    logger.event(
        key="hunt_last_priority_job",
        level="info",
        message=f"Priority job: {title} at {company}\n{url}",
        code="priority_job",
        details={"job_id": job_id, "company": company, "title": title},
        discord=False,
    )
    return {
        "job_id": job_id,
        "title": title,
        "company": company,
        "url": url,
    }


def _build_priority_jobs_message(priority_jobs):
    if not priority_jobs:
        return None
    lines = [f"Priority jobs found: {len(priority_jobs)}"]
    for item in priority_jobs:
        lines.append(f"- {item['title']} at {item['company']}")
        lines.append(f"  {item['url']}")
    return "\n".join(lines)


def _notify_priority_jobs(priority_jobs):
    if not priority_jobs:
        return None
    message = _build_priority_jobs_message(priority_jobs)
    result = send_discord_webhook_message(message)
    if result.get("sent"):
        return result
    C1Logger(discord=False).event(
        key="discord_last_priority_notify_error",
        level="warn",
        message=f"Priority job Discord notification failed: {result.get('reason')}",
        code="priority_job_discord_failed",
        details={
            "reason": result.get("reason"),
            "status_code": result.get("status_code"),
            "priority_job_count": len(priority_jobs),
        },
        discord=False,
    )
    return result


def scrape_single(site, term, location, category):
    if site == "linkedin" and _linkedin_discovery_guard_active:
        if _linkedin_discovery_blocked.is_set():
            print(
                f"  [{site}] [{category}] Skipping '{term}' in '{location}': "
                "LinkedIn discovery cooldown is active."
            )
            return []

    print(f"  [{site}] [{category}] Searching: '{term}' in '{location}'...")
    try:
        # Import here so unit tests and non-discovery workflows don't require jobspy.
        from jobspy import scrape_jobs  # type: ignore

        scrape_kwargs = {
            "site_name": [site],
            "search_term": term,
            "location": location,
            "results_wanted": (
                max(1, min(50, LINKEDIN_RESULTS_WANTED)) if site == "linkedin" else RESULTS_WANTED
            ),
            "hours_old": HOURS_OLD,
            "country_indeed": "Canada",
        }
        if site == "linkedin":
            scrape_kwargs["linkedin_fetch_description"] = LINKEDIN_FETCH_DESCRIPTION

        jobs_df = scrape_jobs(**scrape_kwargs)
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

        if category and not title_matches_search_lane(title, category):
            continue

        if not title_matches_target_preferences(
            title,
            category,
            TARGET_JOB_TITLES,
            EXPERIENCE_LEVELS,
        ):
            continue

        company = normalize_optional_str(row.get("company"))

        job_url, apply_url = build_job_urls(row, source)
        description = normalize_optional_str(row.get("description"))
        apply_type, auto_apply_eligible, enrichment_status = build_enrichment_fields(source)

        job_data = {
            "title": title,
            "company": company,
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


def _take_linkedin_task_batch(tasks, limit):
    if not tasks or limit <= 0:
        return []

    count = min(limit, len(tasks))
    with _linkedin_query_cursor_lock:
        start = get_linkedin_discovery_query_cursor() % len(tasks)
        selected = [tasks[(start + offset) % len(tasks)] for offset in range(count)]
        set_linkedin_discovery_query_cursor((start + count) % len(tasks))
    return selected


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
        from hunter.enrich_jobs import process_multi_source_batch

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
    global _linkedin_discovery_guard_active

    init_db()
    logger = C1Logger(discord=False)

    _linkedin_discovery_blocked.clear()
    persisted_cooldown_until = get_linkedin_discovery_cooldown_until()
    persisted_cooldown_active = is_linkedin_discovery_in_cooldown()
    if persisted_cooldown_active:
        _linkedin_discovery_blocked.set()
    elif persisted_cooldown_until:
        clear_linkedin_discovery_cooldown()
        persisted_cooldown_until = None

    cooldown_state = {
        "active": persisted_cooldown_active,
        "until": persisted_cooldown_until,
        "triggered": False,
    }
    cooldown_lock = threading.Lock()

    def activate_linkedin_cooldown(message):
        with cooldown_lock:
            if _linkedin_discovery_blocked.is_set():
                return
            _linkedin_discovery_blocked.set()
            cooldown_until = datetime.now(UTC) + timedelta(
                minutes=max(1, LINKEDIN_DISCOVERY_COOLDOWN_MINUTES)
            )
            formatted_until = cooldown_until.strftime("%Y-%m-%d %H:%M:%S")
            set_linkedin_discovery_cooldown_until(formatted_until)
            cooldown_state.update(
                {
                    "active": True,
                    "until": formatted_until,
                    "triggered": True,
                }
            )
            logger.event(
                key="hunt_last_linkedin_discovery_rate_limit",
                level="warn",
                message=(
                    "LinkedIn discovery returned HTTP 429; queued LinkedIn searches "
                    f"are paused until {formatted_until} UTC."
                ),
                code="linkedin_discovery_rate_limited",
                details={
                    "cooldown_minutes": LINKEDIN_DISCOVERY_COOLDOWN_MINUTES,
                    "cooldown_until": formatted_until,
                    "jobspy_message": message,
                },
            )

    rate_limit_handler = _LinkedInRateLimitHandler(activate_linkedin_cooldown)
    jobspy_linkedin_logger = logging.getLogger("JobSpy:LinkedIn")
    jobspy_linkedin_logger.addHandler(rate_limit_handler)
    _linkedin_discovery_guard_active = True

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
    candidate_tasks = [
        (site, term, location, category)
        for category, terms in SEARCH_QUERIES.items()
        for term in terms
        for location in LOCATIONS
        for site in SITES
    ]
    non_linkedin_tasks = [task for task in candidate_tasks if task[0] != "linkedin"]
    linkedin_candidate_tasks = [task for task in candidate_tasks if task[0] == "linkedin"]
    if persisted_cooldown_active:
        linkedin_tasks = []
        linkedin_tasks_skipped = len(linkedin_candidate_tasks)
        linkedin_tasks_deferred = 0
    else:
        linkedin_tasks = _take_linkedin_task_batch(
            linkedin_candidate_tasks,
            max(1, min(20, LINKEDIN_QUERIES_PER_RUN)),
        )
        linkedin_tasks_skipped = 0
        linkedin_tasks_deferred = len(linkedin_candidate_tasks) - len(linkedin_tasks)
    tasks = non_linkedin_tasks + linkedin_tasks

    logger.event(
        key="hunt_last_scrape_start",
        level="info",
        message="C1 scrape started.",
        code="scrape_started",
        details={
            "task_count": len(tasks),
            "linkedin_tasks_skipped": linkedin_tasks_skipped,
            "linkedin_tasks_selected": len(linkedin_tasks),
            "linkedin_tasks_deferred": linkedin_tasks_deferred,
            "linkedin_discovery_cooldown_until": persisted_cooldown_until,
            "max_workers": MAX_WORKERS,
            "linkedin_max_workers": LINKEDIN_DISCOVERY_MAX_WORKERS,
            "linkedin_results_wanted": LINKEDIN_RESULTS_WANTED,
            "linkedin_fetch_description": LINKEDIN_FETCH_DESCRIPTION,
            "enrich_pending": bool(enrich_pending),
            "enrich_limit": enrich_limit,
        },
    )

    print(f"Starting {len(tasks)} scrape tasks with {MAX_WORKERS} workers...\n")

    try:
        with ExitStack() as stack:
            futures = {}
            if non_linkedin_tasks:
                executor = stack.enter_context(ThreadPoolExecutor(max_workers=max(1, MAX_WORKERS)))
                for task in non_linkedin_tasks:
                    site, term, location, category = task
                    future = executor.submit(scrape_single, site, term, location, category)
                    futures[future] = task
            if linkedin_tasks:
                linkedin_executor = stack.enter_context(
                    ThreadPoolExecutor(max_workers=max(1, min(2, LINKEDIN_DISCOVERY_MAX_WORKERS)))
                )
                for task in linkedin_tasks:
                    site, term, location, category = task
                    future = linkedin_executor.submit(scrape_single, site, term, location, category)
                    futures[future] = task

            for future in as_completed(futures):
                jobs = future.result()
                all_jobs.extend(jobs)

        inserted = 0
        refreshed = 0
        priority_jobs = []
        for job_data in all_jobs:
            add_result = add_job(job_data)
            result = add_result[0]
            job_id = add_result[1]
            if result == "inserted":
                inserted += 1
                if job_data.get("priority"):
                    priority_jobs.append(_record_priority_job(job_id, job_data))
            elif result == "updated":
                refreshed += 1
                priority_changed = len(add_result) > 2 and add_result[2]
                if priority_changed:
                    priority_jobs.append(_record_priority_job(job_id, job_data))

        _notify_priority_jobs(priority_jobs)

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

        summary = {
            "scraped_total": len(all_jobs),
            "inserted": inserted,
            "refreshed": refreshed,
            "skipped": skipped,
            "enrichment_exit_code": enrichment_exit_code,
            "linkedin_discovery_cooldown_active": bool(cooldown_state["active"]),
            "linkedin_discovery_cooldown_until": cooldown_state["until"],
            "linkedin_discovery_cooldown_triggered": bool(cooldown_state["triggered"]),
            "linkedin_tasks_selected": len(linkedin_tasks),
            "linkedin_tasks_deferred": linkedin_tasks_deferred,
        }
        logger.event(
            key="hunt_last_scrape_end",
            level="info",
            message="C1 scrape finished.",
            code="scrape_finished",
            details=summary,
        )
        return summary
    except Exception as exc:
        logger.exception(
            key="hunt_last_scrape_end",
            message="C1 scrape failed.",
            exc=exc,
            code="scrape_failed",
        )
        raise
    finally:
        _linkedin_discovery_guard_active = False
        _linkedin_discovery_blocked.clear()
        jobspy_linkedin_logger.removeHandler(rate_limit_handler)


if __name__ == "__main__":
    import time

    parser = argparse.ArgumentParser(
        description="Run discovery scraping and optionally enrich pending LinkedIn rows."
    )
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
