"""Read only Critical Mass's published employer catalog, not its shared ATS board."""

import json
import re
from urllib.parse import urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import geography_suppression
from hunter.discovery_sources import _job, catalog_error, discovery_result, fetch_text
from hunter.job_posting import html_text
from hunter.search_lanes import matching_search_lane


def _value(value, tag=0):
    if not isinstance(value, list) or len(value) != 2 or value[0] != tag:
        raise ValueError("invalid_employer_catalog")
    return value[1]


def discover_criticalmass(company, plan, *, fetcher=fetch_text):
    jobs, seen, error = [], set(), None
    catalog_complete = False
    try:
        soup = BeautifulSoup(fetcher(plan["url"]), "html.parser")
        islands = [
            node
            for node in soup.select("astro-island[props]")
            if node.get("component-url", "").startswith("/_astro/app-job-list-grid.")
        ]
        if len(islands) != 1:
            raise ValueError("employer_search_response_unrecognized")
        catalog = _value(json.loads(islands[0]["props"])["jobData"])
        groups = _value(catalog["jobs"])
        if not isinstance(groups, dict):
            raise ValueError("invalid_employer_catalog")
        for group in groups.values():
            for encoded in _value(group, 1):
                row = _value(encoded)
                identity, title, target = (
                    _value(row[key]) for key in ("requisition_id", "title", "absolute_url")
                )
                parts = urlsplit(target)
                if (
                    not isinstance(identity, str)
                    or not identity
                    or parts.scheme != "https"
                    or parts.hostname != "interpublic.wd5.myworkdayjobs.com"
                    or not parts.path.startswith("/en-US/OMC/job/")
                    or not re.search(r"_" + re.escape(identity) + r"(?:-\d+)?$", parts.path)
                ):
                    raise ValueError("posting_identity_mismatch")
                if identity in seen:
                    raise ValueError("catalog_repeated")
                seen.add(identity)
                if not isinstance(title, str) or not title.strip():
                    raise ValueError("invalid_listing_title")
                if geography_suppression(_value(row["country"])) in {
                    "outside_canada",
                    "outside_search_geography",
                } or not matching_search_lane(title):
                    continue
                description = html_text(_value(row["content"]) or "")
                # The site publishes updated_at, not the original posting date.
                error = "posting_date_unknown" if description else "description_not_found"
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=_value(_value(row["location"])["name"]),
                        url=target,
                        source="employer_criticalmass",
                        description=description or None,
                    )
                )
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
