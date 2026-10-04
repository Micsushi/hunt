"""Read the public search/detail widgets published by Phenom career sites."""

import re
from urllib.parse import quote, urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import geography_suppression, outside_geography
from hunter.discovery_sources import (
    _job,
    _parse_date,
    _script_object,
    catalog_error,
    discovery_result,
    fetch_text,
    post_public_json,
)
from hunter.job_posting import html_text
from hunter.search_lanes import matching_search_lane


def _config(soup, url):
    config = _script_object(soup, r"\bphApp\s*=\s*phApp\s*\|\|\s*")
    host = urlsplit(url).hostname
    for field in ("baseUrl", "widgetApiEndpoint"):
        parts = urlsplit(config.get(field, ""))
        if parts.scheme != "https" or parts.hostname != host or parts.username or parts.password:
            return {}
    if config.get("siteType") != "external" or not all(
        config.get(k) for k in ("refNum", "locale", "country")
    ):
        return {}
    return config


def phenom_fetch_plan(soup, url):
    config = _config(soup, url)
    if not config:
        return None
    if config.get("pageName") == "search-results":
        return {"method": "phenom", "url": url}
    for link in soup.select("a[href]"):
        target = urljoin(config["baseUrl"], link["href"])
        if urlsplit(target).hostname == urlsplit(url).hostname and urlsplit(target).path.endswith(
            "/search-results"
        ):
            return {"method": "phenom", "url": target}
    return None


def _location(row):
    places = row.get("multi_location") or []
    if not isinstance(places, list):
        places = []
    places = [
        place if isinstance(place, str) else place.get("cityStateCountry") or place.get("location")
        for place in places
        if isinstance(place, (str, dict))
    ]
    places = [place for place in places if isinstance(place, str) and place.strip()]
    if not places:
        name = row.get("cityStateCountry") or row.get("location") or row.get("city") or ""
        country = row.get("standardisedCountry") or row.get("country") or ""
        country = {
            "CA": "Canada",
            "CAN": "Canada",
            "USA": "United States",
            "US": "United States",
        }.get(country, country)
        places = [f"{name}, {country}".strip(", ")]
    return (
        "; ".join(re.sub(r"\bCAN\b", "Canada", place) for place in places if isinstance(place, str))
        or None
    )


def discover_phenom(company, plan, *, fetcher=fetch_text, poster=post_public_json):
    jobs, seen = [], set()
    offset, expected_total, error = 0, None, None
    catalog_complete = False
    try:
        soup = BeautifulSoup(fetcher(plan["url"]), "html.parser")
        config = _config(soup, plan["url"])
        if not config:
            raise ValueError("invalid_phenom_configuration")
        initial = _script_object(soup, r"\bphApp\.ddo\s*=\s*").get("eagerLoadRefineSearch", {})
        facets = initial.get("data", {}).get("aggregations", [])
        countries = next((f.get("value", {}) for f in facets if f.get("field") == "country"), {})
        from hunter.config import DISCOVERY_COUNTRIES

        canada = (
            [
                key
                for key in countries
                if geography_suppression("Canada" if key.casefold() in {"can", "ca"} else key)
                is None
            ]
            if DISCOVERY_COUNTRIES
            else []
        )
        common = {
            "lang": config["locale"],
            "deviceType": "desktop",
            "country": config["country"],
            "pageName": "search-results",
            "refNum": config["refNum"],
            "siteType": "external",
            "pageId": config.get("pageId", ""),
        }
        query = {
            **common,
            "ddoKey": "refineSearch",
            "sortBy": "Most recent",
            "sort": {"order": "desc", "field": "postedDate"},
            "subsearch": "",
            "jobs": True,
            "counts": True,
            "size": 10,
            "clearAll": False,
            "jdsource": "facets",
            "keywords": "",
            "global": True,
            "all_fields": [f["field"] for f in facets if f.get("field")],
            "selected_fields": {"country": canada} if canada else {},
        }
        while True:
            result = poster(config["widgetApiEndpoint"], {**query, "from": offset}).get(
                "refineSearch", {}
            )
            rows, total = result.get("data", {}).get("jobs"), result.get("totalHits")
            if (
                result.get("status") != 200
                or not isinstance(rows, list)
                or type(total) is not int
                or total < 0
            ):
                raise ValueError("invalid_phenom_search")
            if expected_total is not None and expected_total != total:
                raise ValueError("catalog_changed_during_scan")
            expected_total = total
            if offset + len(rows) > total or (not rows and offset < total):
                raise ValueError("catalog_count_mismatch")
            for row in rows:
                identity, title, sequence = row.get("jobId"), row.get("title"), row.get("jobSeqNo")
                if (
                    not isinstance(identity, str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]+", identity)
                    or not title
                    or not sequence
                ):
                    raise ValueError("invalid_phenom_listing")
                if identity in seen:
                    raise ValueError("pagination_repeated")
                seen.add(identity)
                if not matching_search_lane(title):
                    continue
                location = _location(row)
                if outside_geography(location):
                    continue
                description, posted = None, row.get("postedDate")
                try:
                    detail = poster(
                        config["widgetApiEndpoint"],
                        {**common, "ddoKey": "jobDetail", "jobSeqNo": sequence},
                    ).get("jobDetail", {})
                    if detail.get("status") == 404:
                        continue
                    job = detail.get("data", {}).get("job", {})
                    if (
                        detail.get("status") != 200
                        or job.get("jobId") != identity
                        or job.get("jobSeqNo") != sequence
                        or job.get("title") != title
                    ):
                        raise ValueError("detail_identity_mismatch")
                    if "external" not in job.get("jobVisibility", []):
                        raise ValueError("posting_visibility_unverified")
                    location = _location(job)
                    if outside_geography(location):
                        continue
                    description = html_text(job.get("description") or "")
                    if not description:
                        raise ValueError("description_not_found")
                    posted = job.get("postedDate")
                except Exception as exc:
                    error = catalog_error(exc)
                date = _parse_date(posted)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=urljoin(config["baseUrl"], "job/" + quote(identity)),
                        source="employer_phenom",
                        description=description,
                        date_posted=date.date().isoformat() if date else None,
                    )
                )
            offset += len(rows)
            if offset == total:
                break
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, offset or jobs, catalog_complete=catalog_complete)
