"""Read the public Jibe search API published by its employer career-page client."""

import json
from urllib.parse import urlencode, urlsplit

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


def discover_jibe(company, plan, *, fetcher=fetch_text):
    from hunter.config import DISCOVERY_COUNTRIES

    base = urlsplit(plan["url"])
    endpoint = f"{base.scheme}://{base.netloc}/api/jobs"
    jobs, seen, total, client, error = [], set(), None, None, None
    params = {"page": 1, "limit": 100, "internal": "false"}
    aliases = {
        "ca": "Canada",
        "can": "Canada",
        "us": "United States",
        "usa": "United States",
        "uk": "United Kingdom",
        "gb": "United Kingdom",
    }
    if len(DISCOVERY_COUNTRIES) == 1:
        country = DISCOVERY_COUNTRIES[0]
        params["country"] = aliases.get(country.lower(), country)
    try:
        while True:
            data = json.loads(fetcher(endpoint + "?" + urlencode(params)))
            rows, count = data.get("jobs"), data.get("totalCount")
            if not isinstance(rows, list) or type(count) is not int or count < 0:
                raise ValueError("catalog_response_unrecognized")
            if total is not None and count != total:
                raise ValueError("catalog_count_changed")
            total = count
            if not rows and len(seen) != total:
                raise ValueError("catalog_count_mismatch")
            for item in rows:
                row = item.get("data") or {}
                identity = str(row.get("slug") or "")
                if not identity or not row.get("title") or not row.get("client_code"):
                    raise ValueError("posting_identity_missing")
                if client is not None and row["client_code"] != client:
                    raise ValueError("board_identity_mismatch")
                client = row["client_code"]
                if identity in seen:
                    raise ValueError("catalog_repeated")
                seen.add(identity)
                if not matching_search_lane(row["title"]):
                    continue
                places = [row] + list(row.get("additional_locations") or [])
                location = "; ".join(
                    dict.fromkeys(
                        ", ".join(
                            str(place.get(key) or "")
                            for key in ("city", "state", "country")
                            if place.get(key)
                        )
                        for place in places
                    )
                )
                if outside_geography(location):
                    continue
                target = row.get("apply_url") or ""
                parts = urlsplit(target)
                if (
                    parts.scheme != "https"
                    or not parts.hostname
                    or parts.username
                    or f"/jobs/{identity}/" not in parts.path
                ):
                    raise ValueError("application_identity_mismatch")
                posted = _parse_date(row.get("posted_date"))
                description = html_text(row.get("description") or "")
                if not posted or not description:
                    error = error or (
                        "posting_date_unknown" if not posted else "description_not_found"
                    )
                jobs.append(
                    _job(
                        title=row["title"],
                        company=company,
                        location=location,
                        url=target,
                        source="employer_jibe",
                        date_posted=posted.date().isoformat() if posted else None,
                        description=description,
                        employment_type=row.get("employment_type"),
                        is_remote="Remote" in row.get("tags6", []),
                    )
                )
            if len(seen) == total:
                break
            if len(seen) > total:
                raise ValueError("catalog_count_mismatch")
            params["page"] += 1
    except Exception as exc:
        error = catalog_error(exc)
    result, health = discovery_result(plan, jobs, error, seen)
    health["catalog_complete"] = total is not None and len(seen) == total
    return result, health
