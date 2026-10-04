"""
C1 (Hunter) discovery entrypoint (CLI).

This file lives inside the **hunter** package; the name **scraper.py** is historical.
See **docs/NAMING.md** for component IDs and code names.
"""

import argparse
import json
import os
import sys
from datetime import UTC, datetime, timedelta
from functools import partial

if __package__ is None or __package__ == "":
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

from hunter.c1_logging import C1Logger
from hunter.config import (
    BACKFILL_HOURS_OLD,
    COMPANY_CAREER_SITES,
    COMPANY_DISCOVERY_INTERVAL_SECONDS,
    COUNTRY_INDEED,
    ENRICH_AFTER_SCRAPE,
    ENRICHMENT_BATCH_LIMIT,
    ENRICHMENT_HEADFUL,
    ENRICHMENT_SLOW_MO_MS,
    ENRICHMENT_TIMEOUT_MS,
    ENRICHMENT_UI_VERIFY_BLOCKED,
    HOURS_OLD,
    LINKEDIN_FETCH_DESCRIPTION,
    LOCATIONS,
    MAX_WORKERS,
    PUBLIC_DISCOVERY_INTERVAL_SECONDS,
    RESULTS_WANTED,
    REVIEW_APP_PUBLIC_URL,
    SEARCH_TERMS,
    SITES,
)
from hunter.db import (
    add_job,
    count_ready_jobs_for_enrichment,
    get_runtime_state,
    init_db,
    record_company_fetch_result,
    record_discovery_source_health,
    set_runtime_state,
    upsert_company_fetch_queue,
)
from hunter.discovery_browser import resolve_rendered_career_fetch_plan
from hunter.discovery_indeed import discover_indeed_query
from hunter.discovery_linkedin import discover_linkedin_query
from hunter.discovery_policy import annotate_job
from hunter.discovery_run import ScanBusy, ScanRun, ScanStopped
from hunter.discovery_sources import (
    career_fetch_plan,
    catalog_company_sites,
    discover_builtin,
    discover_company_career_site,
    discover_job_bank,
    discover_jobillico,
    discover_public_feeds,
    discover_talentegg,
    discover_vanhack,
    discover_wellfound,
)
from hunter.notifications import send_discord_webhook_message
from hunter.search_lanes import title_matches_search_lane
from hunter.url_utils import detect_ats_type, get_apply_host, normalize_optional_str


def _discovery_due(source):
    key = f"discovery_next_check:{source}"
    row = get_runtime_state([key]).get(key, {})
    try:
        due = datetime.fromisoformat(row.get("value") or "")
        return due.replace(tzinfo=due.tzinfo or UTC) <= datetime.now(UTC)
    except (TypeError, ValueError):
        return True


def _schedule_discovery(source, seconds):
    set_runtime_state(
        f"discovery_next_check:{source}",
        (datetime.now(UTC) + timedelta(seconds=max(60, seconds))).isoformat(),
    )


def _source_retry_delay(health, normal):
    errors = " ".join(str(item.get("error") or "").lower() for item in health)
    if any(
        code in errors
        for code in ("http_403", "security_checkpoint", "sign_in_required", "not_configured")
    ):
        return max(normal, 21600)
    if any(code in errors for code in ("career_adapter_unavailable", "ambiguous_career_boards")):
        return max(normal, 86400)
    if any(code in errors for code in ("http_429", "rate_limited", "refresh_limit")):
        return max(normal, 3600)
    return normal


def _discover_public_sources(hours_old, on_result, *, due_only=False, run=None):
    from hunter import config

    # Public catalogs need each role once; board-only level variants would reread
    # the same catalog many times. The shared title policy still enforces levels.
    search_terms = config.TARGET_JOB_TITLES if config.TARGETING_CONFIGURED else SEARCH_TERMS
    from hunter.discovery_browser import discover_eluta, discover_gc_jobs, discover_jobs_ca
    from hunter.discovery_jobright import discover_jobright

    persistence_error = None
    cycle_key = "jobright_query_cycle"
    profile = {
        "terms": search_terms,
        "countries": config.DISCOVERY_COUNTRIES,
        "hours_old": hours_old,
    }
    saved_cycle = get_runtime_state([cycle_key]).get(cycle_key, {}).get("value")
    cycle = json.loads(saved_cycle) if saved_cycle else {}
    queries = [
        f"jobright: {lane} / {term}"
        for lane, terms in search_terms.items()
        for term in dict.fromkeys(terms)
    ]
    if cycle.get("profile") != profile or not cycle.get("pending"):
        cycle = {"profile": profile, "pending": queries}
    jobright_terms = {
        lane: [term for term in terms if f"jobright: {lane} / {term}" in cycle["pending"]]
        for lane, terms in search_terms.items()
    }

    def persist(jobs, health):
        nonlocal persistence_error
        if persistence_error is not None:
            raise persistence_error
        if run and run.lost:
            raise ScanBusy("Discovery scan ownership was lost")
        try:
            on_result(jobs, health)
            for item in health:
                if item["source"] in cycle["pending"] and (
                    item["status"] == "ok"
                    or (
                        item["status"] == "partial"
                        and item.get("error") != "jobright_search_timeout"
                    )
                ):
                    cycle["pending"].remove(item["source"])
                    set_runtime_state(cycle_key, json.dumps(cycle))
            if run:
                for item in health:
                    if " / " in item["source"]:
                        run.saved(
                            "query:" + item["source"],
                            len(jobs),
                            complete=item["status"] in {"ok", "partial"},
                        )
                if run.stopped():
                    raise ScanStopped()
            if any(row.get("error") == "jobright_hourly_refresh_limit" for row in health):
                set_runtime_state(
                    "jobright_retry_after", (datetime.now(UTC) + timedelta(hours=1)).isoformat()
                )
        except Exception as exc:
            persistence_error = exc
            raise

    sources = [
        (
            "jobright",
            partial(
                discover_jobright,
                hours_old=hours_old,
                on_result=persist,
                search_terms=jobright_terms,
            ),
            True,
        ),
        ("public_feeds", partial(discover_public_feeds, hours_old=hours_old), False),
        ("job_bank", partial(discover_job_bank, search_terms, hours_old=hours_old), False),
        (
            "jobillico",
            partial(
                discover_jobillico,
                run.pending_terms("jobillico", search_terms) if run else search_terms,
                hours_old=hours_old,
                on_result=persist,
            ),
            True,
        ),
        (
            "builtin",
            partial(
                discover_builtin,
                run.pending_terms("builtin", search_terms) if run else search_terms,
                hours_old=hours_old,
                on_result=persist,
            ),
            True,
        ),
        ("wellfound", partial(discover_wellfound, hours_old=hours_old), False),
        ("talentegg", partial(discover_talentegg, search_terms, hours_old=hours_old), False),
        ("vanhack", partial(discover_vanhack, hours_old=hours_old), False),
        ("gc_jobs", partial(discover_gc_jobs, on_result=persist), True),
        (
            "eluta",
            partial(
                discover_eluta,
                run.pending_terms("eluta", search_terms) if run else search_terms,
                on_result=persist,
            ),
            True,
        ),
        (
            "jobs_ca_browser",
            partial(discover_jobs_ca, search_terms, hours_old=hours_old, on_result=persist),
            True,
        ),
    ]

    def discover_source(item):
        source, discover, streamed = item
        if due_only and not _discovery_due(source):
            return
        if persistence_error is not None:
            raise persistence_error
        if run and not run.start("public:" + source):
            return
        if source == "jobright":
            retry = get_runtime_state(["jobright_retry_after"]).get("jobright_retry_after", {})
            try:
                retry_at = datetime.fromisoformat(retry.get("value") or "")
                cooling_down = retry_at.replace(tzinfo=retry_at.tzinfo or UTC) > datetime.now(UTC)
            except (TypeError, ValueError):
                cooling_down = False
            if cooling_down:
                persist(
                    [],
                    [
                        {
                            "source": source,
                            "status": "rate_limited",
                            "lead_count": 0,
                            "error": "jobright_cooldown_until_" + retry_at.isoformat(),
                        }
                    ],
                )
                if run:
                    run.saved("public:" + source)
                return
        geography_limit = next(
            (limit for limit in config.discovery_geography_limits() if limit["source"] == source),
            None,
        )
        if (
            geography_limit
            and not any(c.casefold() in {"canada", "ca", "can"} for c in config.DISCOVERY_COUNTRIES)
            and config.DISCOVERY_COUNTRIES
        ):
            persist(
                [],
                [
                    {
                        "source": source,
                        "status": "unsupported",
                        "lead_count": 0,
                        "error": "This source searches Canada only; selected countries were not searched.",
                    }
                ],
            )
            if run:
                run.saved("public:" + source)
            return
        try:
            result = discover()
            if geography_limit:
                persist(
                    [],
                    [
                        {
                            "source": source + ": geography",
                            "status": "partial",
                            "lead_count": 0,
                            "error": "This source searches Canada only; other selected countries were not searched.",
                        }
                    ],
                )
        except Exception as exc:
            if persistence_error is not None:
                raise persistence_error
            result = (
                [],
                [
                    {
                        "source": source,
                        "status": "failed",
                        "lead_count": 0,
                        "error": type(exc).__name__,
                    }
                ],
            )
            persist(*result)
        else:
            # Some adapters catch transport exceptions broadly; do not hide a failed DB write.
            if persistence_error is not None:
                raise persistence_error
            if not streamed:
                persist(*result)
        _schedule_discovery(
            source,
            _source_retry_delay(result[1] if result else [], PUBLIC_DISCOVERY_INTERVAL_SECONDS),
        )
        if run:
            run.saved("public:" + source)

    with ThreadPoolExecutor(max_workers=2 if run else 1) as executor:
        for future in as_completed([executor.submit(discover_source, item) for item in sources]):
            future.result()


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


def scrape_single(site, term, location, category, *, hours_old=None, raise_errors=False):
    print(f"  [{site}] [{category}] Searching: '{term}' in '{location}'...")
    try:
        # Import here so unit tests and non-discovery workflows don't require jobspy.
        from jobspy import scrape_jobs  # type: ignore

        scrape_kwargs = {
            "site_name": [site],
            "search_term": term,
            "location": location,
            "results_wanted": RESULTS_WANTED,
            "hours_old": HOURS_OLD if hours_old is None else hours_old,
            "country_indeed": COUNTRY_INDEED,
        }
        if site == "linkedin":
            scrape_kwargs["linkedin_fetch_description"] = LINKEDIN_FETCH_DESCRIPTION

        jobs_df = scrape_jobs(**scrape_kwargs)
    except Exception as e:
        print(f"  [{site}] [{category}] Error for '{term}' in '{location}': {e}")
        if raise_errors:
            raise
        return []

    print(f"  [{site}] [{category}] Found {len(jobs_df)} jobs for '{term}' in '{location}'")

    jobs = []
    for _, row in jobs_df.iterrows():
        title = normalize_optional_str(row.get("title"))
        source = normalize_optional_str(row.get("site")) or site

        if not title:
            continue

        if category and not title_matches_search_lane(title, category):
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
            "employment_type": normalize_optional_str(row.get("job_type")),
            "level": classify_level(title),
            "category": category,
            "apply_type": apply_type,
            "auto_apply_eligible": auto_apply_eligible,
            "enrichment_status": enrichment_status,
            "enrichment_attempts": 0,
            "apply_host": get_apply_host(apply_url),
            "ats_type": detect_ats_type(apply_url),
        }
        if job_data["job_url"]:
            jobs.append(annotate_job(job_data))
    return jobs


def _scrape_jobspy_task(site, term, location, category, hours_old):
    source = f"jobspy_{site}: {category} / {term} / {location}"
    try:
        if site in {"linkedin", "indeed"}:
            if site == "linkedin":
                jobs, health = discover_linkedin_query(
                    term,
                    location,
                    category,
                    hours_old=hours_old,
                    fetch_description=LINKEDIN_FETCH_DESCRIPTION,
                )
            else:
                jobs, health = discover_indeed_query(term, location, category, hours_old=hours_old)
            jobs = [
                annotate_job(
                    {
                        **job,
                        "level": classify_level(job.get("title")),
                    }
                )
                for job in jobs
            ]
            record_discovery_source_health(source, **{**health, "lead_count": len(jobs)})
            return jobs
        jobs = scrape_single(site, term, location, category, hours_old=hours_old, raise_errors=True)
        # JobSpy returns an empty batch for HTTP failures and does not expose terminal-page
        # evidence. Neither zero results nor a batch below the configured cap proves completion.
        record_discovery_source_health(
            source,
            status="partial",
            lead_count=len(jobs),
            error="upstream_search_completion_unverified",
        )
        return jobs
    except Exception as exc:
        record_discovery_source_health(source, status="failed", error=str(exc)[:500])
        return []


def _discover_company_queue(
    on_result=None, hours_old=BACKFILL_HOURS_OLD, *, due_only=False, run=None, refresh_plans=False
):
    jobs = []
    cutoff = (datetime.now(UTC) - timedelta(hours=hours_old)).date().isoformat()
    configured = COMPANY_CAREER_SITES or catalog_company_sites()
    sites, employers = {}, {}
    for company, boards in configured.items():
        urls = [boards] if isinstance(boards, str) else list(dict.fromkeys(boards))
        for url in urls:
            key = company if len(urls) == 1 else f"{company} [{url}]"
            sites[key], employers[key] = url, company
    if not sites:
        record_discovery_source_health(
            "company_catalog",
            status="failed",
            lead_count=0,
            error="no_configured_or_bundled_company_sites",
        )
    resolved_plans = {}
    for company, career_site in sites.items():
        plan = career_fetch_plan(career_site)
        row = upsert_company_fetch_queue(company, career_site, plan["method"])
        if isinstance(row, dict) and row.get("resolved_url") and row["fetch_method"] != "manual":
            resolved_plans[company] = {"method": row["fetch_method"], "url": row["resolved_url"]}

    def discover(company, url):
        if run and not run.start(f"company:{company}:{url}"):
            return None
        return discover_company_career_site(
            employers[company],
            url,
            hours_old=hours_old,
            rendered_resolver=resolve_rendered_career_fetch_plan,
            **({"refresh_plan": True} if refresh_plans else {}),
            **({"resolved_plan": resolved_plans[company]} if company in resolved_plans else {}),
        )

    with ThreadPoolExecutor(max_workers=max(1, min(MAX_WORKERS, 4))) as executor:
        futures = {
            executor.submit(discover, company, url): company
            for company, url in sites.items()
            if not due_only or _discovery_due(f"company:{company}:{url}")
        }
        for future in as_completed(futures):
            company = futures[future]
            try:
                result = future.result()
                if result is None:
                    continue
                found, health = result
            except Exception as exc:
                found, health = [], {"status": "failed", "error": type(exc).__name__}
            found = [
                job for job in found if not job.get("date_posted") or job["date_posted"] >= cutoff
            ]
            if on_result is None:
                jobs.extend(found)
            else:
                on_result(found)
            resolved_method = health.get("method")
            if resolved_method == "manual" and health["status"] == "failed":
                resolved_method = (
                    None  # An access failure cannot disprove the last known connector.
                )
            record_company_fetch_result(
                company,
                state=health["status"],
                coverage={
                    "catalog": "complete"
                    if health.get("catalog_complete", health["status"] == "ok")
                    else "unverified",
                    "matched": len(found),
                    "descriptions": sum(bool(job.get("description")) for job in found),
                    "dates": sum(bool(job.get("date_posted")) for job in found),
                    "verified_applications": sum(
                        job.get("enrichment_status") in {"done", "done_verified"}
                        and job.get("auto_apply_eligible") is True
                        for job in found
                    ),
                },
                lead_count=len(found),
                error=health.get("error"),
                fetch_method=resolved_method,
                resolved_url=health.get("url") if resolved_method not in {None, "manual"} else None,
            )
            record_discovery_source_health(
                f"company:{company}",
                status=health["status"],
                lead_count=len(found),
                error=health.get("error"),
            )
            _schedule_discovery(
                f"company:{company}:{sites[company]}",
                _source_retry_delay(
                    [health],
                    COMPANY_DISCOVERY_INTERVAL_SECONDS if health["status"] == "ok" else 3600,
                ),
            )
            if run:
                run.saved(f"company:{company}:{sites[company]}", len(found))
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
    from hunter.db import count_ready_public_employer_jobs

    ready_count = count_ready_jobs_for_enrichment() + count_ready_public_employer_jobs()
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
    hours_old=None,
    include_public_sources=False,
    include_company_queue=False,
    discovery_due_only=False,
):
    init_db()
    logger = C1Logger(discord=False)

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

    from hunter import config

    settings = {
        name: getattr(config, name)
        for name in (
            "SEARCH_TERMS",
            "LOCATIONS",
            "SITES",
            "COMPANY_CAREER_SITES",
            "INCLUDE_EXPERIENCED_ROLES",
            "TITLE_BLACKLIST",
            "COMPANY_BLOCKLIST",
            "DISCOVERY_COUNTRIES",
            "CAREER_STAGES",
            "EMPLOYMENT_TYPES",
            "REMOTE_ONLY",
            "COUNTRY_INDEED",
        )
    }
    settings.update(
        hours_old=hours_old,
        public=include_public_sources,
        companies=include_company_queue,
        due_only=discovery_due_only,
    )
    with ScanRun(settings) as run:
        scraped_total = inserted = refreshed = 0
        priority_jobs = []
        save_lock = Lock()

        def save_batch(jobs):
            nonlocal scraped_total, inserted, refreshed
            with save_lock:
                for job_data in jobs:
                    add_result = add_job(job_data)
                    result, job_id = add_result[:2]
                    scraped_total += 1
                    if result == "inserted":
                        inserted += 1
                        if job_data.get("priority"):
                            priority_jobs.append(_record_priority_job(job_id, job_data))
                    elif result == "updated":
                        refreshed += 1
                        if len(add_result) > 2 and add_result[2]:
                            priority_jobs.append(_record_priority_job(job_id, job_data))

        def save_public_batch(jobs, health):
            save_batch(jobs)
            for item in health:
                record_discovery_source_health(
                    item["source"],
                    status=item["status"],
                    lead_count=item["lead_count"],
                    error=item["error"],
                )

        effective_hours_old = HOURS_OLD if hours_old is None else hours_old
        tasks = [
            (site, term, location, category)
            for category, terms in SEARCH_TERMS.items()
            for term in terms
            for location in LOCATIONS
            for site in SITES
        ]

        logger.event(
            key="hunt_last_scrape_start",
            level="info",
            message="C1 scrape started.",
            code="scrape_started",
            details={
                "task_count": len(tasks),
                "max_workers": MAX_WORKERS,
                "enrich_pending": bool(enrich_pending),
                "enrich_limit": enrich_limit,
            },
        )

        print(f"Starting {len(tasks)} scrape tasks with {MAX_WORKERS} workers...\n")

        def discover_boards():
            def discover(task):
                key = "board:" + repr(task)
                if not run.start(key):
                    return
                jobs = _scrape_jobspy_task(*task, effective_hours_old)
                save_batch(jobs)
                run.saved(key, len(jobs))

            with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
                for result in executor.map(discover, tasks):
                    pass

        try:
            # Keep source-family limits and LinkedIn pacing, but don't queue companies behind boards.
            with ThreadPoolExecutor(max_workers=3) as families:
                futures = [families.submit(discover_boards)]
                if include_public_sources:
                    futures.append(
                        families.submit(
                            _discover_public_sources,
                            effective_hours_old,
                            save_public_batch,
                            due_only=discovery_due_only,
                            run=run,
                        )
                    )
                if include_company_queue:
                    futures.append(
                        families.submit(
                            _discover_company_queue,
                            on_result=save_batch,
                            hours_old=effective_hours_old,
                            due_only=discovery_due_only,
                            refresh_plans=not discovery_due_only,
                            run=run,
                        )
                    )
                for future in as_completed(futures):
                    future.result()

            _notify_priority_jobs(priority_jobs)

            skipped = scraped_total - inserted - refreshed
            print(
                f"\nDone! Scraped {scraped_total} total jobs, added {inserted} new to database, "
                f"refreshed {refreshed} existing row(s), skipped {skipped} unchanged duplicate(s)"
            )

            enrichment_exit_code = None
            if enrich_pending and not run.stopped():
                enrichment_exit_code = run_pending_job_enrichment(
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
                "scraped_total": scraped_total,
                "inserted": inserted,
                "refreshed": refreshed,
                "skipped": skipped,
                "enrichment_exit_code": enrichment_exit_code,
                "interrupted": run.stopped(),
            }
            logger.event(
                key="hunt_last_scrape_end",
                level="info",
                message="C1 scrape finished.",
                code="scrape_finished",
                details=summary,
            )
            return summary
        except ScanStopped:
            return {
                "scraped_total": scraped_total,
                "inserted": inserted,
                "refreshed": refreshed,
                "interrupted": True,
            }
        except Exception as exc:
            logger.exception(
                key="hunt_last_scrape_end",
                message="C1 scrape failed.",
                exc=exc,
                code="scrape_failed",
            )
            raise


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
    parser.add_argument(
        "--backfill",
        action="store_true",
        help=f"Use the {BACKFILL_HOURS_OLD}-hour window and include public feeds/company queues.",
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
        hours_old=BACKFILL_HOURS_OLD if args.backfill else None,
        include_public_sources=args.backfill,
        include_company_queue=args.backfill,
    )
    elapsed = time.time() - start
    minutes, seconds = divmod(int(elapsed), 60)
    print(f"Completed in {minutes}m {seconds}s")
