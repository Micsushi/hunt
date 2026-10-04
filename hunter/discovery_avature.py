"""Read public Avature search tables/cards and matching job details."""

import re
from urllib.parse import parse_qs, urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import outside_geography
from hunter.discovery_sources import (
    _job,
    _parse_date,
    catalog_error,
    discovery_result,
    fetch_text,
)
from hunter.search_lanes import matching_search_lane


def discover_avature(company, plan, *, fetcher=fetch_text):
    jobs, seen, visited = [], set(), set()
    url, expected_total, error = plan["url"], None, None
    host = urlsplit(url).hostname
    try:
        while url:
            if url in visited:
                raise ValueError("pagination_repeated")
            visited.add(url)
            soup = BeautifulSoup(fetcher(url), "html.parser")
            counts = soup.select_one(".list-controls__text")
            match = re.search(
                r"(?:\d+\s*-\s*\d+\s+of\s+)?([\d,]+)\s+result",
                counts.get_text(" ", strip=True) if counts else "",
                re.I,
            )
            if not match:
                raise ValueError("catalog_count_missing")
            total = int(match[1].replace(",", ""))
            if expected_total is not None and total != expected_total:
                raise ValueError("catalog_changed_during_scan")
            expected_total = total
            rows = soup.select(
                'a[data-map="job-detail-link"][href], .article__header__text__title a[href]'
            )
            if not rows and len(seen) < total:
                raise ValueError("catalog_count_mismatch")
            for link in rows:
                target = urljoin(url, link["href"])
                parts = urlsplit(target)
                identity = re.search(r"/careers/JobDetail/[^/]+/(\d+)/?$", parts.path)
                if parts.hostname != host or parts.scheme != "https" or not identity:
                    raise ValueError("invalid_avature_job_url")
                if identity[1] in seen:
                    raise ValueError("pagination_repeated")
                seen.add(identity[1])
                title = link.get_text(" ", strip=True)
                if not matching_search_lane(title):
                    continue
                row = link.find_parent("tr")
                cells = row.select("td") if row else []
                location = cells[0].get_text(" ", strip=True) if cells else None
                card = link.find_parent("article")
                if card:
                    location = "; ".join(
                        node.get_text(" ", strip=True)
                        for node in card.select(
                            ".list-item-location, .list-item-jobPostingLocation"
                        )
                    )
                if card and outside_geography(location):
                    continue
                if location and re.search(r"possible locations", location, re.I):
                    location = None
                description, posted = None, None
                try:
                    detail = BeautifulSoup(fetcher(target), "html.parser")
                    fields = {}
                    for field in detail.select(".article__content__view__field"):
                        label = field.select_one(".article__content__view__field__label")
                        value = field.select_one(".article__content__view__field__value")
                        if not label and value:
                            label = value.select_one("strong")
                        if label and value:
                            name = label.get_text(" ", strip=True)
                            fields[name.rstrip(":")] = (
                                value.get_text(" ", strip=True).removeprefix(name).strip()
                            )
                    heading = detail.select_one("main h2.title--11, h2.banner__text__title")
                    if (
                        (fields.get("Job number") or fields.get("Role ID")) != identity[1]
                        or not heading
                        or heading.get_text(" ", strip=True) != title
                    ):
                        raise ValueError("detail_identity_mismatch")
                    locations = []
                    for frame in detail.select("main iframe[src]"):
                        map_url = urlsplit(frame["src"])
                        if map_url.hostname == "maps.google.com" and map_url.path == "/maps":
                            locations.extend(parse_qs(map_url.query).get("q", []))
                    if locations:
                        location = "; ".join(
                            dict.fromkeys(filter(None, [fields.get("Location(s)"), *locations]))
                        )
                    if outside_geography(location):
                        continue
                    content = detail.select_one("main article.table-fields-label--hidden")
                    if content is None:
                        content = next(
                            (
                                article
                                for article in detail.select("article.article--details")
                                if article.find(
                                    ["h2", "h3"],
                                    string=re.compile(r"Description.*Requirements", re.I),
                                )
                            ),
                            None,
                        )
                    description = content.get_text("\n", strip=True) if content else None
                    if not description:
                        raise ValueError("description_not_found")
                    for section in content.find_next_siblings("article", class_="article--details"):
                        description += "\n" + section.get_text("\n", strip=True)
                    posted = _parse_date(fields.get("Posting date"))
                    if posted is None:
                        error = error or "posting_date_unknown"
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=target,
                        source="employer_avature",
                        description=description,
                        date_posted=posted.date().isoformat() if posted else None,
                    )
                )
            if len(seen) > total:
                raise ValueError("catalog_count_mismatch")
            if len(seen) == total:
                break
            next_link = soup.select_one("a.paginationNextLink[href]")
            if not next_link:
                raise ValueError("pagination_incomplete")
            url = urljoin(url, next_link["href"])
            if (
                urlsplit(url).hostname != host
                or urlsplit(url).scheme != "https"
                or urlsplit(url).path.rstrip("/") != urlsplit(plan["url"]).path.rstrip("/")
            ):
                raise ValueError("invalid_pagination_url")
    except Exception as exc:
        error = catalog_error(exc)
    jobs, health = discovery_result(plan, jobs, error, seen)
    health["catalog_complete"] = expected_total is not None and len(seen) == expected_total
    return jobs, health
