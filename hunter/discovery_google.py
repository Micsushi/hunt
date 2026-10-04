"""Read Google's public career directory without inferring publication dates."""

import re
from urllib.parse import parse_qs, urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_sources import _job, catalog_error, discovery_result, fetch_text
from hunter.search_lanes import matching_search_lane


def discover_google(company, plan, *, fetcher=fetch_text):
    jobs, seen, pages, total, error = [], set(), set(), None, None
    url = plan["url"]
    expected_locations = parse_qs(urlsplit(url).query).get("location")
    root = "https://www.google.com/about/careers/applications/"
    try:
        while url:
            if url in pages:
                raise ValueError("repeated_page")
            pages.add(url)
            soup = BeautifulSoup(fetcher(url), "html.parser")
            count = re.search(
                r"Showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+rows", soup.get_text(" ", strip=True)
            )
            cards = soup.select("li.lLd3Je")
            if (
                not count
                or (total is not None and int(count[3]) != total)
                or int(count[1]) != len(seen) + 1
                or int(count[2]) - int(count[1]) + 1 != len(cards)
            ):
                raise ValueError("catalog_count_mismatch")
            total = int(count[3])
            for card in cards:
                heading = card.select_one("h3")
                link = card.select_one('a[href*="jobs/results/"]')
                target = urljoin(root, link["href"]) if link else ""
                parts = urlsplit(target)
                identity = re.fullmatch(
                    r"/about/careers/applications/jobs/results/(\d+)-[^/]+/?", parts.path
                )
                if (
                    not identity
                    or parts.hostname != "www.google.com"
                    or parts.scheme != "https"
                    or heading is None
                ):
                    raise ValueError("posting_identity_mismatch")
                if identity[1] in seen:
                    raise ValueError("catalog_repeated")
                seen.add(identity[1])
                title = heading.get_text(" ", strip=True)
                if not matching_search_lane(title):
                    continue
                target = parts._replace(query="", fragment="").geturl()
                location = "; ".join(
                    dict.fromkeys(n.get_text(" ", strip=True) for n in card.select(".r0wTof"))
                )
                description = None
                try:
                    detail = BeautifulSoup(fetcher(target), "html.parser")
                    meta = detail.select_one('meta[property="og:url"]')
                    article = detail.select_one(".DkhPwc")
                    actual = article.select_one("h2.p1N2lc") if article else None
                    if (
                        meta is None
                        or meta.get("content")
                        != "https://careers.google.com/jobs/results/" + identity[1]
                        or actual is None
                        or actual.get_text(" ", strip=True) != title
                    ):
                        raise ValueError("detail_identity_mismatch")
                    sections = article.select(".KwJkGe,.aG5W3,.BDNOWe")
                    if len(sections) != 3:
                        raise ValueError("description_not_found")
                    description = "\n".join(n.get_text("\n", strip=True) for n in sections)
                    error = error or "posting_date_unknown"
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=target,
                        source="employer_google",
                        description=description,
                        date_posted=None,
                    )
                )
            link = soup.select_one('a[aria-label="Go to next page"][href]')
            url = urljoin(root, link["href"]) if link else None
            if len(seen) > total or (not url and len(seen) != total):
                raise ValueError("catalog_count_mismatch")
            if url and (
                urlsplit(url).hostname != "www.google.com"
                or urlsplit(url).scheme != "https"
                or urlsplit(url).path != "/about/careers/applications/jobs/results/"
                or parse_qs(urlsplit(url).query).get("location") != expected_locations
            ):
                raise ValueError("invalid_pagination_url")
    except Exception as exc:
        error = catalog_error(exc)
    jobs, health = discovery_result(plan, jobs, error, seen)
    health["catalog_complete"] = total is not None and len(seen) == total
    return jobs, health
