"""Read UKG's normal public catalog response and published posting data."""

from uuid import UUID

from bs4 import BeautifulSoup

from hunter.browser_runtime import open_public_browser
from hunter.discovery_policy import outside_geography
from hunter.discovery_sources import (
    _job,
    _parse_date,
    _script_object,
    catalog_error,
    discovery_result,
    fetch_text,
)
from hunter.job_posting import html_text
from hunter.search_lanes import matching_search_lane


def read_ukg_catalog(url):

    endpoint = url.rstrip("/") + "/JobBoardView/LoadSearchResults"
    with open_public_browser() as browser:
        page = browser.new_page()
        with page.expect_response(
            lambda r: r.url == endpoint and r.request.method == "POST", timeout=30_000
        ) as response:
            page.goto(url, wait_until="domcontentloaded", timeout=25_000)
        response = response.value
        if response.status != 200:
            raise ValueError(f"http_{response.status}")
        request = response.request.post_data_json
        if request.get("opportunitySearch", {}).get("Skip") != 0:
            raise ValueError("pagination_request_mismatch")
        catalog = response.json()
        try:
            while len(catalog["opportunities"]) < catalog["totalCount"]:
                with page.expect_response(
                    lambda r: r.url == endpoint and r.request.method == "POST", timeout=30_000
                ) as following:
                    page.locator('[data-automation="load-more-jobs-link"]').click(timeout=10_000)
                response = following.value
                if response.status != 200:
                    raise ValueError(f"http_{response.status}")
                expected = {
                    **request,
                    "opportunitySearch": {
                        **request["opportunitySearch"],
                        "Skip": len(catalog["opportunities"]),
                    },
                }
                if response.request.post_data_json != expected:
                    raise ValueError("pagination_request_mismatch")
                _append_page(catalog, response.json())
        except Exception as exc:
            catalog["_pagination_error"] = catalog_error(exc)
        return catalog


def _append_page(catalog, following):
    rows = following.get("opportunities")
    if (
        not isinstance(rows, list)
        or not rows
        or type(catalog.get("totalCount")) is not int
        or following.get("totalCount") != catalog["totalCount"]
        or len(catalog["opportunities"]) + len(rows) > catalog["totalCount"]
    ):
        raise ValueError("pagination_count_mismatch")
    identities = [r.get("Id") for r in catalog["opportunities"] + rows]
    if len(set(identities)) != len(identities):
        raise ValueError("catalog_repeated")
    catalog["opportunities"].extend(rows)


def discover_ukg(company, plan, *, reader=read_ukg_catalog, fetcher=fetch_text):
    jobs, seen, error = [], set(), None
    base = plan["url"].rstrip("/")
    catalog_complete = False
    try:
        catalog = reader(base)
        error = catalog.get("_pagination_error")
        rows, total = catalog.get("opportunities"), catalog.get("totalCount")
        if not isinstance(rows, list) or type(total) is not int or total < len(rows):
            raise ValueError("catalog_count_mismatch")
        if total != len(rows):
            error = error or "pagination_not_verified"
        for row in rows:
            identity = row.get("Id")
            if not isinstance(identity, str) or str(UUID(identity)) != identity:
                raise ValueError("posting_identity_mismatch")
            if identity in seen:
                raise ValueError("catalog_repeated")
            seen.add(identity)
            title = (row.get("Title") or "").strip()
            if not title:
                raise ValueError("invalid_listing_title")
            places = []
            for place in row.get("Locations") or []:
                address = place.get("Address") or {}
                places.append(
                    ", ".join(
                        filter(
                            None,
                            (
                                address.get("City"),
                                (address.get("State") or {}).get("Name"),
                                (address.get("Country") or {}).get("Name"),
                            ),
                        )
                    )
                )
            location = "; ".join(filter(None, places)) or None
            if outside_geography(location) or not matching_search_lane(title):
                continue
            url = f"{base}/OpportunityDetail?opportunityId={identity}"
            description, posted = None, _parse_date(row.get("PostedDate"))
            try:
                soup = BeautifulSoup(fetcher(url), "html.parser")
                detail = _script_object(
                    soup, r"new\s+US\.Opportunity\.CandidateOpportunityDetail\s*\(\s*"
                )
                if (
                    detail.get("Id") != identity
                    or detail.get("Title") != row["Title"]
                    or not row.get("RequisitionNumber")
                    or detail.get("RequisitionNumber") != row["RequisitionNumber"]
                ):
                    raise ValueError("detail_identity_mismatch")
                if detail.get("OpportunityIsClosed") is True:
                    continue
                if detail.get("OpportunityIsClosed") is not False:
                    raise ValueError("posting_status_unknown")
                description = html_text(detail.get("Description") or "")
                if not description:
                    raise ValueError("description_not_found")
                if posted is None:
                    error = error or "posting_date_unknown"
            except Exception as exc:
                error = catalog_error(exc)
            jobs.append(
                _job(
                    title=title,
                    company=company,
                    location=location,
                    url=url,
                    source="employer_ukg",
                    description=description,
                    date_posted=posted.date().isoformat() if posted else None,
                )
            )
        catalog_complete = len(seen) == total and not catalog.get("_pagination_error")
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
