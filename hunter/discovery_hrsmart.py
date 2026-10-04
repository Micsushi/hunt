"""Read HRsmart's public job table and published next-page links."""

import re
from datetime import datetime
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_sources import _job, catalog_error, discovery_result, fetch_text
from hunter.search_lanes import matching_search_lane


def discover_hrsmart(company, plan, *, fetcher=fetch_text):
    jobs, seen, pages, total, error = [], set(), set(), None, None
    url = plan["url"]
    catalog_complete = False
    try:
        while url:
            if url in pages:
                raise ValueError("pagination_repeated")
            pages.add(url)
            soup = BeautifulSoup(fetcher(url), "html.parser")
            table = soup.select_one("#jobSearchResultsGrid_table")
            count = re.search(
                r"Displaying\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)", soup.get_text(" ", strip=True)
            )
            if table is None or count is None:
                raise ValueError("employer_search_response_unrecognized")
            rows = [row for row in table.select("tr") if row.select("td")]
            first, last, reported = map(int, count.groups())
            if (
                first != len(seen) + 1
                or last - first + 1 != len(rows)
                or last > reported
                or (total is not None and total != reported)
            ):
                raise ValueError("catalog_count_mismatch")
            total = reported
            headers = [node.get_text(" ", strip=True) for node in table.select("th")]
            for row in rows:
                cells = row.select("td")
                if len(cells) != len(headers):
                    raise ValueError("invalid_listing")
                fields = dict(zip(headers, cells))
                link = fields["Job Title"].select_one("a[href]")
                identity = fields["Req. #"].get_text(strip=True)
                target = urljoin(url, link["href"]) if link else ""
                parts = urlsplit(target)
                if (
                    not identity.isdigit()
                    or parts.scheme != "https"
                    or parts.hostname != urlsplit(plan["url"]).hostname
                    or parts.path != "/hr/ats/Posting/view/" + identity
                ):
                    raise ValueError("posting_identity_mismatch")
                if identity in seen:
                    raise ValueError("catalog_repeated")
                seen.add(identity)
                title = link.get_text(" ", strip=True)
                if not matching_search_lane(title):
                    continue
                location = fields["Location"].get_text("; ", strip=True)
                description, posted = None, None
                try:
                    posted = (
                        datetime.strptime(fields["Date Opened"].get_text(strip=True), "%m/%d/%Y")
                        .date()
                        .isoformat()
                    )
                except ValueError:
                    error = error or "posting_date_unknown"
                try:
                    detail = BeautifulSoup(fetcher(target), "html.parser")
                    heading = detail.select_one("#job_details_ats_requisition_title")
                    if (
                        heading is None
                        or heading.get_text(" ", strip=True) != title
                        or not any(
                            node.get_text(" ", strip=True) == f"{title} - ({identity})"
                            for node in detail.select("h2")
                        )
                    ):
                        raise ValueError("detail_identity_mismatch")
                    content = detail.select_one("#job_details_ats_requisition_description")
                    if content is None or not content.get_text(strip=True):
                        raise ValueError("description_not_found")
                    description = content.get_text("\n", strip=True)
                except Exception as exc:
                    error = catalog_error(exc)
                jobs.append(
                    _job(
                        title=title,
                        company=company,
                        location=location,
                        url=target,
                        source="employer_hrsmart",
                        description=description,
                        date_posted=posted,
                    )
                )
            next_links = {
                urljoin(url, node["href"]) for node in soup.select("a.paginateNext[href]")
            }
            if len(next_links) > 1:
                raise ValueError("invalid_pagination_url")
            url = next(iter(next_links), None)
            if url:
                parts = urlsplit(url)
                if (
                    parts.scheme != "https"
                    or parts.hostname != urlsplit(plan["url"]).hostname
                    or not parts.path.startswith("/hr/ats/JobSearch/viewAll/")
                ):
                    raise ValueError("invalid_pagination_url")
            if (len(seen) < total and not url) or (len(seen) == total and url):
                raise ValueError("catalog_count_mismatch")
        catalog_complete = True
    except Exception as exc:
        error = catalog_error(exc)
    return discovery_result(plan, jobs, error, seen, catalog_complete=catalog_complete)
