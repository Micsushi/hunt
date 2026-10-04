"""Read SuccessFactors' public unified RMK search service."""

import re
from datetime import UTC, datetime, timedelta
from html import unescape
from urllib.parse import parse_qsl, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import outside_geography
from hunter.discovery_sources import (
    _job,
    catalog_error,
    discovery_result,
    fetch_text,
    post_public_json,
)
from hunter.search_lanes import matching_search_lane


def read_detail(html, row):
    soup = BeautifulSoup(html, "html.parser")
    title = soup.select_one('[itemprop="title"]')
    scripts = "\n".join(n.get_text() for n in soup.select("script:not([src])"))
    if (
        title is None
        or title.get_text(" ", strip=True) != row["unifiedStandardTitle"]
        or not re.search(r"\bjobID\s*:\s*" + re.escape(row["id"]) + r"\b", scripts)
    ):
        raise ValueError("detail_identity_mismatch")
    description = "\n\n".join(
        n.get_text("\n", strip=True) for n in soup.select('[itemprop="description"]')
    ).strip()
    if not description:
        raise ValueError("description_not_found")
    return description


def discover_rmk(company, plan, *, fetcher=fetch_text, poster=post_public_json, hours_old=None):
    parts = urlsplit(plan["url"])
    origin = f"https://{parts.netloc}"
    locale = dict(parse_qsl(parts.query)).get("locale", "en_US")
    jobs, seen, total, error = [], set(), None, None
    cutoff = (
        (datetime.now(UTC) - timedelta(hours=hours_old)).date() if hours_old is not None else None
    )
    catalog_complete = False
    try:
        if parts.scheme != "https" or not re.fullmatch(r"[a-z]{2}_[A-Z]{2}", locale):
            raise ValueError("board_identity_mismatch")
        page = 0
        while True:
            data = poster(
                origin + "/services/recruiting/v1/jobs",
                {
                    "locale": locale,
                    "pageNumber": page,
                    "sortBy": "date",
                    "keywords": "",
                    "location": "",
                    "facetFilters": {},
                    "brand": "",
                    "skills": [],
                    "categoryId": 0,
                    "alertId": "",
                    "rcmCandidateId": "",
                },
            )
            rows, current = data.get("jobSearchResult"), data.get("totalJobs")
            if not isinstance(rows, list) or type(current) is not int or current < 0:
                raise ValueError("employer_search_response_unrecognized")
            if total is not None and total != current:
                raise ValueError("catalog_changed_during_scan")
            total = current
            if not rows and len(seen) != total:
                raise ValueError("catalog_count_mismatch")
            for record in rows:
                row = record.get("response", {})
                identity = row.get("id", "")
                title = row.get("unifiedStandardTitle", "")
                slug = unescape(row.get("unifiedUrlTitle", ""))
                if (
                    not isinstance(identity, str)
                    or not identity.isdigit()
                    or not title
                    or not slug
                    or re.search(r"[/\\?#]", slug)
                ):
                    raise ValueError("invalid_listing")
                if identity in seen:
                    raise ValueError("catalog_repeated")
                seen.add(identity)
                location = "; ".join(row.get("mfield1", []))
                if outside_geography(location) or not matching_search_lane(title):
                    continue
                try:
                    posted = datetime.strptime(
                        row.get("unifiedStandardStart", ""), "%m/%d/%y"
                    ).date()
                except (ValueError, TypeError):
                    posted = None
                    error = error or "posting_date_unknown"
                if cutoff and posted and posted < cutoff:
                    continue
                target = f"{origin}/job/{slug}/{identity}-{locale}"
                description = None
                try:
                    description = read_detail(fetcher(target), row)
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=target,
                        source="employer_successfactors",
                        description=description,
                        date_posted=posted.isoformat() if posted else None,
                    )
                )
                if error in {"http_403", "http_429", "security_checkpoint"}:
                    raise ValueError(error)
            if len(seen) == total:
                break
            if len(seen) > total:
                raise ValueError("catalog_count_mismatch")
            page += 1
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, total is not None, catalog_complete=catalog_complete)
