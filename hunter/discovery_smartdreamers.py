"""Read SmartDreamers' published Algolia catalog and employer posting details."""

import json
import re
from urllib.parse import urlencode, urljoin, urlsplit

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


def discover_smartdreamers(company, plan, *, fetcher=fetch_text, poster=post_public_json):
    from hunter.config import DISCOVERY_COUNTRIES

    jobs, seen, error, loaded = [], set(), None, False
    try:
        soup = BeautifulSoup(fetcher(plan["url"]), "html.parser")
        scripts = soup.select('script[src*="/merged/js/"]')
        if len(scripts) != 1:
            raise ValueError("catalog_configuration_ambiguous")
        script_url = urljoin(plan["url"], scripts[0]["src"])
        if urlsplit(script_url).scheme != "https":
            raise ValueError("invalid_catalog_script")
        script = fetcher(script_url)
        clients = re.findall(
            r"algoliasearch\(\s*['\"]([A-Z0-9]+)['\"]\s*,\s*['\"]([a-zA-Z0-9]+)['\"]\s*\)", script
        )
        indexes = re.findall(r"indexName\s*:\s*['\"]([A-Za-z0-9_-]+)['\"]", script)
        if len(clients) != 1 or len(set(indexes)) != 1:
            raise ValueError("catalog_configuration_ambiguous")
        app, key = clients[0]
        page, total = 0, None
        while total is None or len(seen) < total:
            data = poster(
                f"https://{app.lower()}-dsn.algolia.net/1/indexes/*/queries",
                {
                    "requests": [
                        {
                            "indexName": indexes[0],
                            "params": urlencode(
                                {
                                    "page": page,
                                    "hitsPerPage": 100,
                                    "facetFilters": json.dumps(
                                        [["country:" + c for c in DISCOVERY_COUNTRIES]]
                                    )
                                    if DISCOVERY_COUNTRIES
                                    else "[]",
                                }
                            ),
                        }
                    ]
                },
                headers={"X-Algolia-Application-Id": app, "X-Algolia-API-Key": key},
            )
            result = data["results"][0]
            rows, reported = result.get("hits"), result.get("nbHits")
            if (
                not isinstance(rows, list)
                or type(reported) is not int
                or reported < 0
                or result.get("page") != page
                or result.get("index") != indexes[0]
                or result.get("exhaustiveNbHits") is not True
                or total is not None
                and total != reported
            ):
                raise ValueError("catalog_count_unverified")
            total = reported
            for row in rows:
                title = row["title"]
                targets, requisitions = row.get("redirect_url"), row.get("reqid")
                if (
                    not isinstance(targets, list)
                    or len(targets) != 1
                    or not isinstance(requisitions, list)
                    or len(requisitions) != 1
                ):
                    raise ValueError("posting_identity_mismatch")
                target, reqid = targets[0], requisitions[0]
                parts = urlsplit(target)
                if (
                    parts.scheme != "https"
                    or parts.hostname != urlsplit(plan["url"]).hostname
                    or not parts.path.endswith("/reqid/" + reqid)
                    or not title
                ):
                    raise ValueError("posting_identity_mismatch")
                if reqid in seen:
                    raise ValueError("catalog_repeated")
                seen.add(reqid)
                location = ", ".join([*row.get("work_location", []), *row.get("country", [])])
                if outside_geography(location) or not matching_search_lane(title):
                    continue
                description = None
                try:
                    detail = BeautifulSoup(fetcher(target), "html.parser")
                    heading, reference = (
                        detail.select_one(".page-headline"),
                        detail.select_one("#custom_field_reqid"),
                    )
                    if (
                        not heading
                        or heading.get_text(" ", strip=True) != title
                        or not reference
                        or reference.get_text(strip=True) != reqid
                    ):
                        raise ValueError("detail_identity_mismatch")
                    content = detail.select_one(".description-content > .description-page-right")
                    description = content.get_text("\n", strip=True) if content else None
                    if not description:
                        raise ValueError("description_not_found")
                    error = error or "posting_date_unknown"
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=target,
                        source="employer_smartdreamers",
                        description=description,
                    )
                )
            if len(seen) > total or not rows and len(seen) < total:
                raise ValueError("catalog_count_mismatch")
            page += 1
        loaded = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, loaded or seen, catalog_complete=loaded)
