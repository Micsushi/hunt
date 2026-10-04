"""Read Apple's public search pages and their published posting data."""

import json
import re
from urllib.parse import parse_qs, urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import outside_geography
from hunter.discovery_sources import (
    _job,
    _parse_date,
    catalog_error,
    discovery_result,
    fetch_text,
)
from hunter.job_posting import html_text
from hunter.search_lanes import matching_search_lane


def _page(raw):
    soup = BeautifulSoup(raw, "html.parser")
    for script in soup.select("script:not([src])"):
        match = re.search(
            r"window\.__staticRouterHydrationData\s*=\s*JSON\.parse\(", script.get_text()
        )
        if match:
            encoded, _ = json.JSONDecoder().raw_decode(script.get_text()[match.end() :].lstrip())
            return soup, json.loads(encoded)["loaderData"]
    raise ValueError("employer_response_unrecognized")


def _location(row):
    return "; ".join(
        ", ".join(
            dict.fromkeys(
                str(location.get(key) or "").strip()
                for key in ("name", "stateProvince", "countryName")
                if location.get(key)
            )
        )
        for location in row.get("locations", [])
    )


def discover_apple(company, plan, *, fetcher=fetch_text):
    jobs, seen, total, error = [], set(), None, None
    catalog_complete = False
    expected_location = parse_qs(urlsplit(plan["url"]).query).get("location", [None])[0]
    page = 1
    try:
        while True:
            url = plan["url"] + (
                ("&" if "?" in plan["url"] else "?") + f"page={page}" if page > 1 else ""
            )
            soup, data = _page(fetcher(url))
            catalog = data["search"]
            rows, reported = catalog.get("searchResults"), catalog.get("totalRecords")
            links = soup.select('h3 a[href*="/details/"]')
            if (
                not isinstance(rows, list)
                or type(reported) is not int
                or reported < 0
                or catalog.get("page") != page
                or catalog.get("queryParams", {}).get("location") != expected_location
                or len(links) != len(rows)
                or (total is not None and total != reported)
                or len(seen) + len(rows) > reported
                or (not rows and len(seen) < reported)
            ):
                raise ValueError("catalog_count_mismatch")
            total = reported
            targets = {}
            for link in links:
                target = urljoin(url, link["href"])
                parts = urlsplit(target)
                match = re.fullmatch(r"/[a-z]{2}-[a-z]{2}/details/([0-9-]+)/[^/]+", parts.path)
                if parts.scheme != "https" or parts.hostname != "jobs.apple.com" or not match:
                    raise ValueError("posting_identity_mismatch")
                if match[1] in targets:
                    raise ValueError("catalog_repeated")
                targets[match[1]] = (target, link.get_text(" ", strip=True))
            for row in rows:
                identity, title = row.get("id"), str(row.get("postingTitle") or "").strip()
                if row.get("type") == "PIPE" and identity == "PIPE-" + str(row.get("positionId")):
                    identity = str(row["positionId"])
                if identity not in targets or targets[identity][1] != title:
                    raise ValueError("posting_identity_mismatch")
                if identity in seen:
                    raise ValueError("catalog_repeated")
                seen.add(identity)
                if row.get("postExternal") is not True or not matching_search_lane(title):
                    continue
                target, _ = targets[identity]
                description, posted, location = None, None, _location(row)
                if outside_geography(location):
                    continue
                try:
                    _, detail = _page(fetcher(target))
                    posting = detail["jobDetails"]["jobsData"]
                    if (
                        posting.get("jobNumber") != identity
                        or str(posting.get("postingTitle") or "").strip() != title
                    ):
                        raise ValueError("detail_identity_mismatch")
                    if not posting.get("description"):
                        raise ValueError("description_not_found")
                    description = "\n\n".join(
                        label + "\n" + html_text(str(posting[key]))
                        for key, label in (
                            ("jobSummary", "Summary"),
                            ("description", "Description"),
                            ("minimumQualifications", "Minimum qualifications"),
                            ("preferredQualifications", "Preferred qualifications"),
                        )
                        if posting.get(key)
                    )
                    location = _location(posting)
                    date = _parse_date(posting.get("postDateInGMT"))
                    posted = date.date().isoformat() if date else None
                    if not posted:
                        error = error or "posting_date_unknown"
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=target,
                        source="employer_apple",
                        description=description,
                        date_posted=posted,
                    )
                )
            if len(seen) == total:
                break
            page += 1
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
