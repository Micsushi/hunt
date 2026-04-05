import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from jobspy import scrape_jobs
from db import init_db, add_job
from config import SEARCH_TERMS, LOCATIONS, SITES, MAX_WORKERS, RESULTS_WANTED, HOURS_OLD, WATCHLIST, TITLE_BLACKLIST
from concurrent.futures import ThreadPoolExecutor, as_completed
from url_utils import detect_ats_type, get_apply_host, normalize_optional_str


def classify_level(title):
    if not title or not isinstance(title, str):
        return "unknown"

    title_lower = title.lower()

    if any(word in title_lower for word in ["intern", "student", "co-op", "coop", "internship"]):
        return "intern"

    if any(word in title_lower for word in ["new grad", "new graduate", "entry level", "entry-level", "graduate"]):
        return "new_grad"

    if any(word in title_lower for word in ["junior", "associate", "jr.", "jr ", "engineer i", "developer i", "level 1", "l1"]):
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
    if source != "linkedin":
        return None, None, None

    # Discovery may retain a best-known outbound URL hint, but LinkedIn rows
    # stay queued for browser verification until enrichment classifies the
    # primary action as Easy Apply vs external Apply.
    return "unknown", None, "pending"


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


def scrape():
    init_db()

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
        result = add_job(job_data)
        if result == "inserted":
            inserted += 1
        elif result == "updated":
            refreshed += 1

    skipped = len(all_jobs) - inserted - refreshed
    print(
        f"\nDone! Scraped {len(all_jobs)} total jobs, added {inserted} new to database, "
        f"refreshed {refreshed} existing row(s), skipped {skipped} unchanged duplicate(s)"
    )


if __name__ == "__main__":
    import time

    start = time.time()
    scrape()
    elapsed = time.time() - start
    minutes, seconds = divmod(int(elapsed), 60)
    print(f"Completed in {minutes}m {seconds}s")
