"""Read the public Eightfold career search shared by multiple employers."""

import json
from datetime import UTC, datetime
from urllib.parse import urlencode, urljoin, urlsplit

from hunter.discovery_policy import outside_geography
from hunter.discovery_sources import (
    _job,
    catalog_error,
    discovery_result,
    fetch_text,
    resolve_career_fetch_plan,
)
from hunter.job_posting import html_text
from hunter.search_lanes import matching_search_lane


def discover_eightfold(company, plan, *, fetcher=fetch_text):
    from hunter.config import DISCOVERY_COUNTRIES

    location_filter = DISCOVERY_COUNTRIES[0] if len(DISCOVERY_COUNTRIES) == 1 else ""
    base = "https://" + urlsplit(plan["url"]).netloc
    jobs, seen, total, error = [], set(), None, None
    catalog_complete = False

    def read(endpoint, query):
        payload = json.loads(fetcher(base + "/api/pcsx/" + endpoint + "?" + urlencode(query)))
        if payload.get("status") != 200 or not isinstance(payload.get("data"), dict):
            raise ValueError("invalid_employer_response")
        return payload["data"]

    try:
        if not plan.get("domain"):
            resolved = resolve_career_fetch_plan(plan["url"], fetcher=fetcher, follow_links=False)
            if resolved.get("method") != "eightfold" or not resolved.get("domain"):
                raise ValueError("board_identity_mismatch")
            plan = resolved
        while True:
            data = read(
                "search",
                {
                    "domain": plan["domain"],
                    "query": "",
                    "location": location_filter,
                    "start": len(seen),
                },
            )
            rows, reported = data.get("positions"), data.get("count")
            if (
                not isinstance(rows, list)
                or type(reported) is not int
                or reported < 0
                or (total is not None and total != reported)
                or (not rows and len(seen) < reported)
                or len(seen) + len(rows) > reported
            ):
                raise ValueError("catalog_count_mismatch")
            total = reported
            for row in rows:
                identity = str(row.get("id", ""))
                url = urljoin(base, row.get("positionUrl") or "")
                if (
                    not identity.isdigit()
                    or urlsplit(url).hostname != urlsplit(base).hostname
                    or urlsplit(url).scheme != "https"
                    or urlsplit(url).path != "/careers/job/" + identity
                ):
                    raise ValueError("posting_identity_mismatch")
                if identity in seen:
                    raise ValueError("catalog_repeated")
                seen.add(identity)
                title = str(row.get("name") or "").strip()
                if not title:
                    raise ValueError("invalid_listing_title")
                location = "; ".join(row.get("locations") or [])
                if outside_geography(location) or not matching_search_lane(title):
                    continue
                description, posted = None, None
                try:
                    detail = read(
                        "position_details",
                        {
                            "position_id": identity,
                            "domain": plan["domain"],
                            "hl": "en",
                            "queried_location": location_filter,
                        },
                    )
                    if (
                        str(detail.get("id")) != identity
                        or detail.get("name") != title
                        or detail.get("publicUrl") != url
                        or str(detail.get("atsJobId")) != str(row.get("atsJobId"))
                    ):
                        raise ValueError("detail_identity_mismatch")
                    location = "; ".join(detail.get("locations") or [])
                    if outside_geography(location):
                        continue
                    description = html_text(detail.get("jobDescription") or "")
                    if not description:
                        raise ValueError("description_not_found")
                    stamp = detail.get("postedTs")
                    if type(stamp) in {int, float} and stamp > 0:
                        posted = datetime.fromtimestamp(stamp, UTC).date().isoformat()
                    else:
                        error = error or "posting_date_unknown"
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=url,
                        source="employer_eightfold",
                        description=description,
                        date_posted=posted,
                    )
                )
            if len(seen) == total:
                break
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
