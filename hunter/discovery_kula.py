"""Read Kula's public rendered catalog and structured job details."""

import json
import re
from datetime import UTC, datetime
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import outside_geography
from hunter.discovery_sources import (
    _job,
    _parse_date,
    catalog_error,
    discovery_result,
    fetch_text,
)
from hunter.job_posting import html_text, job_postings
from hunter.search_lanes import matching_search_lane


def discover_kula(company, plan, *, fetcher=fetch_text):
    jobs, error, catalog_read = [], None, False
    base = plan["url"].rstrip("/")
    catalog_complete = False
    try:
        soup = BeautifulSoup(fetcher(base), "html.parser")
        catalogs = []
        decoder = json.JSONDecoder()
        for node in soup.select("script:not([src])"):
            for push in re.finditer(r"self\.__next_f\.push\(", node.get_text()):
                payload = decoder.raw_decode(node.get_text()[push.end() :])[0]
                if len(payload) != 2 or payload[0] != 1 or not isinstance(payload[1], str):
                    continue
                for match in re.finditer(r'"jobs"\s*:\s*(?=\[)', payload[1]):
                    catalogs.append(decoder.raw_decode(payload[1][match.end() :])[0])
        if len(catalogs) != 1:
            raise ValueError("catalog_not_found")
        rows = catalogs[0]
        links = {}
        for link in soup.select("a[href]"):
            target = urljoin(base + "/", link["href"])
            parts = urlsplit(target)
            match = re.fullmatch(re.escape(urlsplit(base).path) + r"/(\d+)-[^/]+", parts.path)
            if parts.scheme == "https" and parts.hostname == "careers.kula.ai" and match:
                links[match[1]] = target
        ids = [str(row["id"]) for row in rows]
        if len(set(ids)) != len(ids) or set(ids) != set(links):
            raise ValueError("catalog_count_mismatch")
        catalog_read = True
        for row in rows:
            if row.get("listed") is not True or row.get("kind") not in {
                "external",
                "internal_and_external",
            }:
                raise ValueError("posting_visibility_unverified")
            title, identity = row["title"], str(row["id"])
            location = "; ".join(p["location"] for p in row["ats_job"]["offices"])
            if outside_geography(location) or not matching_search_lane(title):
                continue
            target = links[identity]
            description, posted = None, None
            try:
                detail = BeautifulSoup(fetcher(target), "html.parser")
                postings = job_postings(detail)
                if len(postings) != 1:
                    raise ValueError("detail_not_found")
                posting = postings[0]
                if (
                    posting.get("title") != title
                    or str(posting.get("identifier", {}).get("value")) != identity
                ):
                    raise ValueError("detail_identity_mismatch")
                expires = _parse_date(posting.get("validThrough"))
                if expires and expires < datetime.now(UTC):
                    continue
                description = html_text(posting.get("description") or "")
                if not description:
                    raise ValueError("description_not_found")
                posted = _parse_date(posting.get("datePosted"))
            except Exception as exc:
                error = catalog_error(exc)
            jobs.append(
                _job(
                    title=title,
                    company=company,
                    location=location,
                    url=target,
                    source="employer_kula",
                    description=description,
                    date_posted=posted.date().isoformat() if posted else None,
                )
            )
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, catalog_read, catalog_complete=catalog_complete)
