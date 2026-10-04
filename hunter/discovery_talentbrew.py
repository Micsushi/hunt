"""Read public TalentBrew search tables and structured employer posting details."""

import json
from datetime import UTC, datetime
from urllib.parse import urlencode, urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import outside_geography
from hunter.discovery_sources import (
    _job,
    _parse_date,
    catalog_error,
    discovery_result,
    fetch_text,
)
from hunter.job_posting import html_text, job_postings
from hunter.search_lanes import matching_search_lane


def discover_talentbrew(company, plan, *, fetcher=fetch_text):
    jobs, seen, pages, total, error = [], set(), set(), None, None
    total_pages = None
    url = plan["url"]
    catalog_complete = False
    try:
        while url:
            if url in pages:
                raise ValueError("repeated_page")
            pages.add(url)
            raw = fetcher(url)
            if len(pages) > 1:
                payload = json.loads(raw)
                if not isinstance(payload.get("results"), str):
                    raise ValueError("invalid_employer_response")
                raw = payload["results"]
            soup = BeautifulSoup(raw, "html.parser")
            listing = soup.select_one(
                "#search-results[data-total-results][data-current-page][data-total-pages]"
            )
            if listing is None:
                raise ValueError("employer_search_response_unrecognized")
            reported = int(listing["data-total-results"])
            page = int(listing["data-current-page"])
            last = int(listing["data-total-pages"])
            cards = listing.select("#search-results-list li a[data-job-id][href]")
            if (
                page != len(pages)
                or page > max(last, 1)
                or last < 0
                or (total_pages is not None and total_pages != last)
                or (total is not None and total != reported)
                or (not cards and reported > len(seen))
                or len(seen) + len(cards) > reported
            ):
                raise ValueError("catalog_count_mismatch")
            total = reported
            total_pages = last
            for link in cards:
                target = urljoin(url, link["href"])
                parsed = urlsplit(target)
                if (
                    parsed.scheme != "https"
                    or parsed.hostname != urlsplit(plan["url"]).hostname
                    or not parsed.path.startswith("/job/")
                ):
                    raise ValueError("posting_identity_mismatch")
                if target in seen:
                    raise ValueError("catalog_repeated")
                seen.add(target)
                heading = link.select_one("h2")
                title = heading.get_text(" ", strip=True) if heading else ""
                if not title:
                    raise ValueError("invalid_listing_title")
                location_node = link.select_one(".job-location")
                location = location_node.get_text(" ", strip=True) if location_node else ""
                if outside_geography(location) or not matching_search_lane(title):
                    continue
                description, posted = None, None
                try:
                    detail = BeautifulSoup(fetcher(target), "html.parser")
                    postings = job_postings(detail)
                    if (
                        len(postings) != 1
                        or postings[0].get("url") != target
                        or postings[0].get("title") != title
                    ):
                        raise ValueError("detail_identity_mismatch")
                    row = postings[0]
                    expires = _parse_date(row.get("validThrough"))
                    if expires and expires < datetime.now(UTC):
                        continue
                    description = html_text(row.get("description") or "")
                    if not description:
                        raise ValueError("description_not_found")
                    date = _parse_date(row.get("datePosted"))
                    posted = date.date().isoformat() if date else None
                    if posted is None:
                        error = error or "posting_date_unknown"
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=target,
                        source="employer_talentbrew",
                        description=description,
                        date_posted=posted,
                    )
                )
            next_link = listing.select_one('a.next[href]:not(.disabled):not([aria-hidden="true"])')
            next_url = None
            if next_link:
                endpoint = urljoin(plan["url"], listing.get("data-ajax-url") or "")
                if (
                    urlsplit(endpoint).hostname != urlsplit(plan["url"]).hostname
                    or urlsplit(endpoint).scheme != "https"
                    or not listing.get("data-ajax-url")
                ):
                    raise ValueError("invalid_pagination_url")
                fields = {
                    "ActiveFacetID": "active-facet-id",
                    "RecordsPerPage": "records-per-page",
                    "Distance": "distance",
                    "Keywords": "keywords",
                    "Location": "location",
                    "Latitude": "latitude",
                    "Longitude": "longitude",
                    "ShowRadius": "show-radius",
                    "CustomFacetName": "custom-facet-name",
                    "FacetTerm": "facet-term",
                    "FacetType": "facet-type",
                    "SearchResultsModuleName": "search-results-module-name",
                    "SortCriteria": "sort-criteria",
                    "SortDirection": "sort-direction",
                    "SearchType": "search-type",
                    "LocationType": "location-type",
                    "LocationPath": "location-path",
                    "OrganizationIds": "organization-ids",
                    "PostalCode": "postal-code",
                    "ResultsType": "results-type",
                }
                query = {
                    key: listing.get("data-" + attribute, "") for key, attribute in fields.items()
                }
                query.update(
                    CurrentPage=page + 1,
                    RadiusUnitType=0,
                    IsPagination="False",
                    SearchFiltersModuleName="Search Filters",
                )
                next_url = endpoint + "?" + urlencode(query)
            url = next_url
            if (page < last and not url) or (page == last and (url or len(seen) != total)):
                raise ValueError("catalog_count_mismatch")
            if url and (
                urlsplit(url).hostname != urlsplit(plan["url"]).hostname
                or urlsplit(url).scheme != "https"
            ):
                raise ValueError("invalid_pagination_url")
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
