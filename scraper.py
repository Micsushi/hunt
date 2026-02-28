from jobspy import scrape_jobs
from db import init_db, add_job
from config import SEARCH_TERMS, LOCATIONS, SITES, MAX_WORKERS, WATCHLIST, TITLE_BLACKLIST
from concurrent.futures import ThreadPoolExecutor, as_completed

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

def scrape_single(site, term, location, category):
    print(f"  [{site}] [{category}] Searching: '{term}' in '{location}'...")
    try:
        jobs_df = scrape_jobs(
            site_name=[site],
            search_term=term,
            location=location,
            results_wanted=500,
            hours_old=24,
            country_indeed="Canada",
        )
    except Exception as e:
        print(f"  [{site}] [{category}] Error for '{term}' in '{location}': {e}")
        return []

    print(f"  [{site}] [{category}] Found {len(jobs_df)} jobs for '{term}' in '{location}'")

    jobs = []
    for _, row in jobs_df.iterrows():
        title = row.get("title")

        if should_skip(title):
            continue

        job_data = {
            "title": title,
            "company": row.get("company"),
            "location": row.get("location"),
            "job_url": str(row.get("job_url")) if row.get("job_url") else None,
            "apply_url": str(row.get("job_url")) if row.get("job_url") else None,
            "description": row.get("description"),
            "source": row.get("site"),
            "date_posted": str(row.get("date_posted")) if row.get("date_posted") else None,
            "is_remote": row.get("is_remote"),
            "level": classify_level(title),
            "priority": is_priority(row.get("company")),
            "category": category,
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

    added = 0
    for job_data in all_jobs:
        if add_job(job_data):
            added += 1

    print(f"\nDone! Scraped {len(all_jobs)} total jobs, added {added} new to database ({len(all_jobs) - added} duplicates skipped)")

if __name__ == "__main__":
    import time
    start = time.time()
    scrape()
    elapsed = time.time() - start
    minutes, seconds = divmod(int(elapsed), 60)
    print(f"Completed in {minutes}m {seconds}s")
