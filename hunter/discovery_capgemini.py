"""Read Capgemini's published Canadian feed and verify its employer details."""

import json
import re
from datetime import UTC, datetime
from html import unescape
from itertools import count
from urllib.parse import urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_sources import _job, catalog_error, discovery_result, fetch_text
from hunter.search_lanes import matching_search_lane


def discover_capgemini(company, plan, *, fetcher=fetch_text):
    jobs, seen, urls, total, error = [], set(), set(), None, None
    catalog_complete = False
    try:
        for page in count(1):
            payload = json.loads(
                fetcher(
                    "https://cg-jobstream-api.azurewebsites.net/api/job-search"
                    f"?country_code=en-ca&page={page}&size=100"
                )
            )
            rows, reported = payload.get("data"), payload.get("total")
            if (
                not isinstance(rows, list)
                or type(reported) is not int
                or reported < 0
                or payload.get("count") != reported
                or payload.get("timed_out")
                or (total is not None and total != reported)
                or (not rows and len(seen) < reported)
                or len(seen) + len(rows) > reported
            ):
                raise ValueError("catalog_count_mismatch")
            total = reported
            for row in rows:
                identity = row.get("id")
                target = urlsplit(row.get("apply_job_url") or "")
                if (
                    not isinstance(identity, str)
                    or not identity
                    or target.scheme != "https"
                    or target.hostname != "careers.capgemini.com"
                    or not re.fullmatch(r"/job/[^/]+/[0-9]+/", target.path)
                    or row.get("country_code") != "en-ca"
                ):
                    raise ValueError("posting_identity_mismatch")
                url = target._replace(query="", fragment="").geturl()
                if identity in seen or url in urls:
                    raise ValueError("catalog_repeated")
                seen.add(identity)
                urls.add(url)
                title = " ".join(str(row.get("title") or "").split())
                if not title:
                    raise ValueError("invalid_listing_title")
                if row.get("status") not in {"0", "1"}:
                    raise ValueError("posting_status_missing")
                if row.get("deleted_at") or row.get("status") == "0":
                    continue
                if not matching_search_lane(title):
                    continue
                description, posted = None, None
                location = ", ".join(filter(None, [row.get("location"), "Canada"]))
                try:
                    detail = BeautifulSoup(fetcher(url), "html.parser")
                    if any(
                        n.get_text(" ", strip=True)
                        in {
                            "Sorry, this job posting has ended.",
                            "Sorry, this position has been filled.",
                        }
                        for n in detail.select("strong")
                    ):
                        continue
                    canonical = detail.select_one('link[rel="canonical"][href]')
                    heading = detail.select_one("h1")
                    country = detail.select_one('meta[itemprop="addressCountry"]')
                    if (
                        canonical is None
                        or unescape(canonical["href"]) != url
                        or heading is None
                        or " ".join(heading.get_text(" ", strip=True).split()) != title
                        or country is None
                        or country.get("content") != "CA"
                    ):
                        raise ValueError("detail_identity_mismatch")
                    expiry = detail.select_one('meta[itemprop="validThrough"][content]')
                    if expiry and datetime.strptime(
                        expiry["content"], "%a %b %d %H:%M:%S UTC %Y"
                    ).replace(tzinfo=UTC) < datetime.now(UTC):
                        continue
                    content = detail.select_one('[itemprop="description"]')
                    description = content.get_text("\n", strip=True) if content else None
                    if not description:
                        raise ValueError("description_not_found")
                    date = detail.select_one('meta[itemprop="datePosted"][content]')
                    if date:
                        posted = (
                            datetime.strptime(date["content"], "%a %b %d %H:%M:%S UTC %Y")
                            .date()
                            .isoformat()
                        )
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
                        source="employer_capgemini",
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
