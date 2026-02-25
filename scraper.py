from jobspy import scrape_jobs
from db import init_db, add_job
from concurrent.futures import ThreadPoolExecutor, as_completed

def classify_level(title):
    if not title:
        return "unknown"
    
    title_lower = title.lower()
    
    if any(word in title_lower for word in ["intern", "student", "co-op", "coop", "internship"]):
        return "intern"
    
    if any(word in title_lower for word in ["new grad", "new graduate", "entry level", "entry-level", "graduate"]):
        return "new_grad"
    
    if any(word in title_lower for word in ["junior", "associate", "jr.", "jr ", "engineer i", "developer i", "level 1", "l1"]):
        return "junior"
    
    return "unknown"

SEARCH_TERMS = [
    "software engineer intern",
    "software engineer new grad",
    "junior software engineer",
    "software developer intern",
    "software developer new grad",
    "junior software developer",
]

LOCATIONS = [
    "Canada",
    # "Remote",
]

SITES = ["indeed", "linkedin", "glassdoor"]

MAX_WORKERS = 5

def scrape_single(site, term, location):
    print(f"  [{site}] Searching: '{term}' in '{location}'...")
    try:
        jobs_df = scrape_jobs(
            site_name=[site],
            search_term=term,
            location=location,
            results_wanted=1000,
            hours_old=24,
            country_indeed="Canada",
        )
    except Exception as e:
        print(f"  [{site}] Error for '{term}' in '{location}': {e}")
        return []

    print(f"  [{site}] Found {len(jobs_df)} jobs for '{term}' in '{location}'")

    jobs = []
    for _, row in jobs_df.iterrows():
        job_data = {
            "title": row.get("title"),
            "company": row.get("company"),
            "location": row.get("location"),
            "job_url": str(row.get("job_url")) if row.get("job_url") else None,
            "apply_url": str(row.get("job_url")) if row.get("job_url") else None,
            "description": row.get("description"),
            "source": row.get("site"),
            "date_posted": str(row.get("date_posted")) if row.get("date_posted") else None,
            "is_remote": row.get("is_remote"),
            "level": classify_level(row.get("title")),
        }
        if job_data["job_url"]:
            jobs.append(job_data)
    return jobs

def scrape():
    init_db()

    all_jobs = []
    tasks = [
        (site, term, location)
        for term in SEARCH_TERMS
        for location in LOCATIONS
        for site in SITES
    ]

    print(f"Starting {len(tasks)} scrape tasks with {MAX_WORKERS} workers...\n")

    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {
            executor.submit(scrape_single, site, term, location): (site, term, location)
            for site, term, location in tasks
        }

        for future in as_completed(futures):
            jobs = future.result()
            all_jobs.extend(jobs)

    added = 0
    for job_data in all_jobs:
        add_job(job_data)
        added += 1

    print(f"\nDone! Scraped {len(all_jobs)} total jobs, added {added} to database")

if __name__ == "__main__":
    scrape()
