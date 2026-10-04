"""Use JobSpy's Indeed parser with explicit cursor completion and verified TLS."""

from urllib.error import HTTPError

from hunter.discovery_run import check_cancelled
from hunter.discovery_sources import _job, catalog_error
from hunter.search_lanes import title_matches_search_lane


def _indeed_client(term, location, hours_old):
    from jobspy.indeed import Indeed
    from jobspy.model import Country, ScraperInput, Site

    from hunter.config import COUNTRY_INDEED

    country = getattr(Country, COUNTRY_INDEED.upper().replace(" ", "_"), None) or next(
        (
            item
            for item in Country
            if COUNTRY_INDEED.casefold() in {item.name.replace("_", " ").casefold(), *item.value}
        ),
        None,
    )
    if country is None:
        raise ValueError("unsupported_indeed_country")

    client = Indeed()
    client.scraper_input = ScraperInput(
        site_type=[Site.INDEED],
        search_term=term,
        location=location,
        country=country,
        hours_old=hours_old,
        distance=50,
    )
    domain, client.api_country_code = country.indeed_domain_value
    client.base_url = f"https://{domain}.indeed.com"
    original_post = client.session.post

    def checked_post(url, **kwargs):
        kwargs["verify"] = True
        response = original_post(url, **kwargs)
        if not response.ok:
            raise HTTPError(url, response.status_code, "Indeed search failed", None, None)
        payload = response.json()
        if payload.get("errors") or not isinstance(
            (payload.get("data") or {}).get("jobSearch"), dict
        ):
            raise ValueError("indeed_search_response_invalid")
        return response

    # Only this owned client's transport changes; never mutate the installed package/global session.
    client.session.post = checked_post
    return client


def discover_indeed_query(term, location, category, *, hours_old=24, client_factory=_indeed_client):
    jobs, seen, cursors = [], set(), set()
    cursor, client, error = None, None, None
    try:
        client = client_factory(term, location, hours_old)
        while True:
            check_cancelled()
            rows, next_cursor = client._scrape_page(cursor)
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
                    company=row.company_name,
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
