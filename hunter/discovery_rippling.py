"""Read Rippling's public, server-rendered catalog and job detail data."""

import json
import re
from urllib.parse import urlsplit

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


def discover_rippling(company, plan, *, fetcher=fetch_text):
    jobs, seen, error = [], set(), None
    base = plan["url"].rstrip("/")
    slug = urlsplit(base).path.split("/")[-2]

    def page_data(url):
        soup = BeautifulSoup(fetcher(url), "html.parser")
        node = soup.select_one('script#__NEXT_DATA__[type="application/json"]')
        data = json.loads(node.get_text() if node else "{}")["props"]["pageProps"]
        if data["apiData"]["jobBoard"]["slug"] != slug:
            raise ValueError("board_identity_mismatch")
        return data

    expected, page = None, 0
    catalog_complete = False
    try:
        while True:
            data = page_data(f"{base}?page={page}")
            catalogs = [
                q["state"]["data"]
                for q in data["dehydratedState"]["queries"]
                if q.get("queryKey", [])[:3] == ["board", slug, "job-posts"]
            ]
            if len(catalogs) != 1:
                raise ValueError("catalog_not_found")
            catalog = catalogs[0]
            total = catalog["totalItems"]
            if not isinstance(total, int) or total < 0 or catalog["page"] != page:
                raise ValueError("invalid_pagination")
            if expected is not None and expected != total:
                raise ValueError("catalog_changed_during_scan")
            expected = total
            rows = catalog["items"]
            if not rows and len(seen) < total:
                raise ValueError("pagination_incomplete")
            for row in rows:
                identity = row["id"]
                if not re.fullmatch(r"[0-9a-f-]{36}", identity):
                    raise ValueError("invalid_job_id")
                if identity in seen:
                    raise ValueError("pagination_repeated")
                seen.add(identity)
                title = row["name"]
                location = "; ".join(x["name"] for x in row["locations"])
                if outside_geography(location) or not matching_search_lane(title):
                    continue
                target = f"{base}/{identity}"
                description, posted = None, None
                try:
                    detail = page_data(target)["apiData"]["jobPost"]
                    if detail["uuid"] != identity or detail["name"] != title:
                        raise ValueError("detail_identity_mismatch")
                    if detail.get("unlistedFromSearch") is not False:
                        raise ValueError("job_visibility_not_verified")
                    content = detail["description"]
                    role = html_text(content.get("role") or "")
                    if not role:
                        raise ValueError("description_not_found")
                    description = html_text(content.get("company") or "") + "\n" + role
                    posted = _parse_date(detail.get("createdOn"))
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=target,
                        source="employer_rippling",
                        description=description,
                        date_posted=posted.date().isoformat() if posted else None,
                    )
                )
            if len(seen) > total:
                raise ValueError("catalog_count_mismatch")
            if len(seen) == total:
                break
            page += 1
            if page >= catalog["totalPages"]:
                raise ValueError("pagination_incomplete")
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
