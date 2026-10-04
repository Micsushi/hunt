"""Read Amazon's public search catalog to its reported end."""

import json
import re
from datetime import datetime
from urllib.parse import urlencode

from hunter.discovery_policy import outside_geography
from hunter.discovery_sources import _job, catalog_error, discovery_result, fetch_text
from hunter.job_posting import html_text
from hunter.search_lanes import matching_search_lane


def discover_amazon(company, plan, *, fetcher=fetch_text):
    from hunter.config import DISCOVERY_COUNTRIES

    country_names = {
        "CAN": "Canada",
        "USA": "United States",
        "GBR": "United Kingdom",
        "DEU": "Germany",
        "FRA": "France",
        "AUS": "Australia",
        "IND": "India",
        "JPN": "Japan",
    }
    country_filter = next(
        (
            code
            for code, name in country_names.items()
            if DISCOVERY_COUNTRIES == [name] or DISCOVERY_COUNTRIES == [code]
        ),
        None,
    )
    jobs, seen, total, error = [], set(), None, None
    catalog_complete = False
    try:
        while total is None or len(seen) < total:
            url = "https://www.amazon.jobs/en/search.json?" + urlencode(
                {
                    **({"country": country_filter} if country_filter else {}),
                    "offset": len(seen),
                    "result_limit": 10,
                    "sort": "recent",
                }
            )
            data = json.loads(fetcher(url))
            rows, reported = data.get("jobs"), data.get("hits")
            if (
                data.get("error")
                or not isinstance(rows, list)
                or type(reported) is not int
                or reported < 0
            ):
                raise ValueError("invalid_catalog_count")
            if total is not None and total != reported:
                raise ValueError("catalog_count_changed")
            total = reported
            if len(seen) + len(rows) > total or (not rows and len(seen) < total):
                raise ValueError("catalog_count_mismatch")
            for row in rows:
                identity = str(row.get("id_icims") or "")
                path = row.get("job_path") or ""
                if not identity.isdigit() or not re.fullmatch(
                    r"/en/jobs/" + identity + r"/[^/?#]+", path
                ):
                    raise ValueError("posting_identity_mismatch")
                if identity in seen:
                    raise ValueError("catalog_repeated")
                seen.add(identity)
                if country_filter and row.get("country_code") != country_filter:
                    raise ValueError("country_filter_mismatch")
                title = row.get("title")
                if not isinstance(title, str) or not title.strip():
                    raise ValueError("invalid_listing_title")
                location = ", ".join(
                    filter(
                        None,
                        (
                            row.get("city"),
                            row.get("state"),
                            country_names.get(
                                row.get("country_code"),
                                row.get("country") or row.get("country_code"),
                            ),
                        ),
                    )
                )
                if outside_geography(location) or not matching_search_lane(title):
                    continue
                description = html_text(row.get("description") or "")
                if not description:
                    error = error or "description_not_found"
                else:
                    for field, label in (
                        ("basic_qualifications", "Basic qualifications"),
                        ("preferred_qualifications", "Preferred qualifications"),
                    ):
                        text = html_text(row.get(field) or "")
                        if text:
                            description += f"\n{label}\n{text}"
                try:
                    posted = (
                        datetime.strptime(row.get("posted_date") or "", "%B %d, %Y")
                        .date()
                        .isoformat()
                    )
                except ValueError:
                    posted = None
                    error = error or "posting_date_unknown"
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url="https://www.amazon.jobs" + path,
                        source="employer_amazon",
                        description=description or None,
                        date_posted=posted,
                    )
                )
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
