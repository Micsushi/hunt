import json
from urllib.parse import parse_qs, urlsplit

import pytest

from hunter.discovery_sources import resolve_career_fetch_plan
from hunter.discovery_talentbrew import discover_talentbrew


@pytest.mark.parametrize(
    "fault",
    [
        None,
        "count",
        "repeat",
        "identity",
        "date",
        "description",
        "foreign",
        "page_count",
        "insecure",
    ],
)
def test_talentbrew_ajax_paging_and_disabled_last_link(fault):
    root = "https://careers.example.com/search-jobs/Canada"
    calls = []

    def listing(page):
        identity = 1 if fault == "repeat" else page
        total = 3 if fault == "count" and page == 2 else 2
        last = 1 if fault == "page_count" and page == 2 else 2
        target = f"/job/toronto/software-engineer/1/{identity}"
        if fault == "insecure" and page == 2:
            target = "http://careers.example.com" + target
        endpoint = (
            "https://evil.test/search-jobs/results"
            if fault == "foreign"
            else "/search-jobs/results"
        )
        return (
            f'<script src="https://tbcdn.talentbrew.com/client.js"></script>'
            f'<section id="search-results" data-ajax-url="{endpoint}" data-total-results="{total}" data-current-page="{page}" data-total-pages="{last}">'
            f'<ul id="search-results-list"><li><a data-job-id="{identity}" href="{target}">'
            '<h2>Software Engineer</h2><span class="job-location">Toronto, Canada</span></a></li></ul>'
            f'<a class="next {"disabled" if page == 2 else ""}" href="/broken-next">Next</a></section>'
        )

    plan = resolve_career_fetch_plan(root, fetcher=lambda _: listing(1))
    assert plan["method"] == "talentbrew"

    def fetch(url):
        calls.append(url)
        if url == root:
            return listing(1)
        if "/search-jobs/results" in url:
            assert parse_qs(urlsplit(url).query)["CurrentPage"] == ["2"]
            return json.dumps({"results": listing(2)})
        data = {
            "@type": "JobPosting",
            "url": url,
            "title": "Software Engineer",
            "description": "Full job details",
            "datePosted": "2026-9-30",
        }
        if fault == "identity":
            data["title"] = "Different role"
        if fault == "date":
            data.pop("datePosted")
        if fault == "description":
            data["description"] = ""
        return '<script type="application/ld+json">' + json.dumps(data) + "</script>"

    jobs, health = discover_talentbrew("Example", plan, fetcher=fetch)
    assert health["catalog_complete"] == (fault in {None, "identity", "date", "description"})
    assert health["status"] == ("ok" if fault is None else "partial")
    assert not any("evil.test" in url or "broken-next" in url for url in calls)
    assert all(url.startswith("https://") for url in calls)
    if fault is None:
        assert len(jobs) == 2
        assert all(
            j["description"] == "Full job details" and j["date_posted"] == "2026-09-30"
            for j in jobs
        )
    elif fault in {"count", "repeat", "foreign", "page_count", "insecure"}:
        assert len(jobs) == 1
