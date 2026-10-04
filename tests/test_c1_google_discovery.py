from urllib.parse import parse_qs, urlsplit

import pytest

from hunter.discovery_google import discover_google
from hunter.discovery_sources import career_fetch_plan


@pytest.mark.parametrize("fault", [None, "count", "repeat", "foreign", "identity", "description"])
def test_google_full_paging_preserves_unknown_dates_and_failures(fault):
    plan = career_fetch_plan(
        "https://www.google.com/about/careers/applications/jobs/results/?location=Canada"
    )
    calls = []

    def fetch(url):
        calls.append(url)
        if urlsplit(url).path.endswith("/results/"):
            page = int(parse_qs(urlsplit(url).query).get("page", ["1"])[0])
            identity = 1 if fault == "repeat" else page
            total = 3 if fault == "count" and page == 2 else 2
            next_url = plan["url"] + "&page=2"
            if fault == "foreign":
                next_url = next_url.replace("www.google.com", "evil.test")
            link = (
                f'<a aria-label="Go to next page" href="{next_url}">Next</a>' if page == 1 else ""
            )
            return (
                f"Showing {page} to {page} of {total} rows"
                f'<li class="lLd3Je"><h3>Software Engineer</h3><span class="r0wTof">Toronto, Canada</span>'
                f'<a href="jobs/results/{identity}-software-engineer">Learn more</a></li>{link}'
            )
        identity = urlsplit(url).path.rsplit("/", 1)[-1].split("-")[0]
        title = "Different job" if fault == "identity" else "Software Engineer"
        extra = "" if fault == "description" else '<div class="BDNOWe">Responsibilities</div>'
        return (
            f'<meta property="og:url" content="https://careers.google.com/jobs/results/{identity}">'
            f'<div class="DkhPwc"><h2 class="p1N2lc">{title}</h2>'
            '<div class="KwJkGe">Qualifications</div><div class="aG5W3">About the job</div>'
            + extra
            + "</div>"
        )

    jobs, health = discover_google("Google", plan, fetcher=fetch)
    assert health["status"] == "partial"
    assert not any("evil.test" in url for url in calls)
    assert len(jobs) == (1 if fault in {"count", "repeat", "foreign"} else 2)
    assert all(job["date_posted"] is None for job in jobs)
    if fault is None:
        assert health["error"] == "posting_date_unknown"
        assert all(
            job["description"] == "Qualifications\nAbout the job\nResponsibilities" for job in jobs
        )
