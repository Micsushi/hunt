"""Use JobSpy's Indeed parser with explicit cursor completion and verified TLS."""

from urllib.error import HTTPError

from hunter.discovery_run import check_cancelled
from hunter.discovery_sources import _job, catalog_error
from hunter.search_lanes import title_matches_search_lane


def _indeed_client(term, location, hours_old):
    from jobspy.indeed import (
        Indeed,
        RequestsRotating,
        country_codes,
        create_session,
        headers,
        languages,
        subdomains,
    )
    from jobspy.model import Country, ScraperInput, Site

    from hunter.config import COUNTRY_INDEED

    try:
        country = Country(COUNTRY_INDEED)
    except ValueError:
        code = COUNTRY_INDEED.strip().upper()
        country = next((market for market, value in country_codes.items() if value == code), None)
        if country is None:
            raise ValueError("unsupported_indeed_country") from None

    client = Indeed()
    client.scraper_input = ScraperInput(
        site_type=[Site.INDEED],
        search_term=term,
        location=location,
        country_indeed=country,
        hours_old=hours_old,
        distance=50,
    )
    country_code = country_codes[country]
    domain = subdomains.get(country, country_code.lower())
    client.base_url = f"https://{domain}.indeed.com"
    client.session = create_session(
        RequestsRotating(client.scraper_input.proxies),
        client.scraper_input,
        headers
        | {
            "indeed-co": country_code,
            "indeed-locale": f"{languages.get(country_code, 'en')}-{country_code}",
        },
    )
    return client


def _indeed_page(client, cursor):
    from jobspy.indeed import JobSearch

    # JobSpy's public scrape method caps results and swallows transport failures.
    # Use its query builder and models so Hunter can verify the terminal cursor.
    query = client._build_query(client._build_filters(), cursor)
    response = client.session.post(client.api_url, json={"query": query}, verify=True, timeout=20)
    if not response.ok:
        raise HTTPError(client.api_url, response.status_code, "Indeed search failed", None, None)
    try:
        payload = response.json()
        if not isinstance(payload, dict) or payload.get("errors"):
            raise ValueError
        data = payload.get("data")
        if not isinstance(data, dict):
            raise ValueError
        search = data.get("jobSearch")
        if not isinstance(search, dict) or not isinstance(search.get("results"), list):
            raise ValueError
        # Validate the cursor without making one bad card invalidate its siblings.
        page = JobSearch.model_validate({**search, "results": []})
    except ValueError:
        raise ValueError("indeed_search_response_invalid") from None
    rows = []
    invalid = False
    for result in search["results"]:
        job = result.get("job") if isinstance(result, dict) else None
        if not isinstance(job, dict) or not job.get("key"):
            invalid = True
            continue
        try:
            row = client._process_job(job)
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError, OSError):
            invalid = True
            continue
        if row is not None:
            rows.append(row)
    return rows, page.nextCursor, invalid


def discover_indeed_query(
    term,
    location,
    category,
    *,
    hours_old=24,
    client_factory=_indeed_client,
    page_reader=_indeed_page,
):
    jobs, seen, cursors = [], set(), set()
    cursor, client, error = None, None, None
    try:
        client = client_factory(term, location, hours_old)
        while True:
            check_cancelled()
            rows, next_cursor, invalid = page_reader(client, cursor)
            if invalid:
                error = "indeed_search_card_invalid"
            fresh = 0
            for row in rows:
                if not row.job_url or not row.title:
                    error = "indeed_search_card_invalid"
                    continue
                if row.job_url in seen:
                    continue
                seen.add(row.job_url)
                fresh += 1
                if category and not title_matches_search_lane(row.title, category):
                    continue
                job = _job(
                    title=row.title,
                    company=row.company,
                    location=row.location.display_location() if row.location else None,
                    url=row.job_url,
                    source="indeed",
                    category=category,
                    date_posted=str(row.date_posted) if row.date_posted else None,
                    description=row.description,
                )
                job.update(
                    apply_url=row.job_url_direct,
                    apply_host=None,
                    ats_type=None,
                    auto_apply_eligible=None,
                    enrichment_status="pending",
                    last_enrichment_error=None,
                    is_remote=row.is_remote,
                )
                jobs.append(job)
            if not next_cursor:
                break
            if next_cursor in cursors or not fresh:
                error = (
                    "pagination_repeated"
                    if rows or next_cursor in cursors
                    else "empty_page_with_next"
                )
                break
            cursors.add(next_cursor)
            cursor = next_cursor
    except Exception as exc:
        error = catalog_error(exc)
    finally:
        if client is not None:
            client.session.close()
    return jobs, {
        "status": "partial" if error and seen else "failed" if error else "ok",
        "error": error,
        "lead_count": len(jobs),
    }
