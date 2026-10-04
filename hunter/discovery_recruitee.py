"""Read Recruitee's public rendered catalog and structured posting details."""

import json
import re
from datetime import UTC, datetime
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import outside_country
from hunter.discovery_sources import (
    _job,
    _parse_date,
    catalog_error,
    discovery_result,
    fetch_text,
)
from hunter.job_posting import html_text, job_postings
from hunter.search_lanes import matching_search_lane


def discover_recruitee(company, plan, *, fetcher=fetch_text):
    jobs, error, loaded, seen = [], None, False, set()
    catalog_complete = False
    try:
        soup = BeautifulSoup(fetcher(plan["url"]), "html.parser")
        node = soup.select_one('[data-component="PublicApp"][data-props]')
        if node is None:
            raise ValueError("employer_search_response_unrecognized")
        config = json.loads(node["data-props"])["appConfig"]
        site, rows = config["site"], config["offers"]
        if site.get("host") != urlsplit(plan["url"]).hostname or not isinstance(rows, list):
            raise ValueError("board_identity_mismatch")
        counts = set(re.findall(r"\b(\d+) jobs?\b", soup.get_text(" ", strip=True)))
        if counts != {str(len(rows))}:
            raise ValueError("catalog_count_mismatch")
        loaded = True
        links = {
            parts.path
            for a in soup.select("a[href]")
            if (parts := urlsplit(urljoin(plan["url"], a["href"]))).scheme == "https"
            and parts.hostname == urlsplit(plan["url"]).hostname
        }
        for row in rows:
            identity, slug = row.get("externalId"), row.get("slug")
            if (
                type(identity) is not int
                or not isinstance(slug, str)
                or not re.fullmatch(r"[a-zA-Z0-9_-]+", slug)
                or row.get("status") != "published"
                or "/o/" + slug not in links
            ):
                raise ValueError("posting_identity_mismatch")
            if identity in seen:
                raise ValueError("catalog_repeated")
            seen.add(identity)
            translation = row.get("translations", {}).get("en") or row.get("translations", {}).get(
                row.get("primaryLangCode")
            )
            title = translation.get("title") if isinstance(translation, dict) else None
            if not title:
                raise ValueError("invalid_listing")
            if outside_country(row.get("countryCode")) or not matching_search_lane(title):
                continue
            target = urljoin(plan["url"], "/o/" + slug)
            location = ", ".join(
                str(p)
                for p in (row.get("city"), translation.get("state"), translation.get("country"))
                if p
            )
            description, posted = None, None
            try:
                detail = BeautifulSoup(fetcher(target), "html.parser")
                posting = next(iter(job_postings(detail)), None)
                if (
                    posting is None
                    or posting.get("identifier", {}).get("value") != identity
                    or posting.get("title") != title
                    or posting.get("hiringOrganization", {}).get("name") != site.get("name")
                    or not any(h.get_text(" ", strip=True) == title for h in detail.select("h1"))
                ):
                    raise ValueError("detail_identity_mismatch")
                expires = _parse_date(posting.get("validThrough"))
                if expires and expires < datetime.now(UTC):
                    continue
                description = html_text(posting.get("description") or "")
                if not description:
                    raise ValueError("description_not_found")
                posted = _parse_date(posting.get("datePosted"))
                if not posted:
                    error = error or "posting_date_unknown"
            except Exception as exc:
                error = catalog_error(exc)
            jobs.append(
                _job(
                    title=title,
                    company=company,
                    location=location or None,
                    url=target,
                    source="employer_recruitee",
                    description=description,
                    date_posted=posted.date().isoformat() if posted else None,
                )
            )
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, loaded, catalog_complete=catalog_complete)
