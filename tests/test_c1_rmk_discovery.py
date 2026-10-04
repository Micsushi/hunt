from unittest.mock import Mock

import pytest

from hunter.discovery_rmk import discover_rmk
from hunter.discovery_sources import resolve_career_fetch_plan


@pytest.mark.parametrize(
    "fault", [None, "repeat", "count", "empty", "identity", "description", "date", "rate_limit"]
)
def test_rmk_pages_dates_and_complete_description(fault):
    plan = {"method": "rmk", "url": "https://example.test/search/?locale=en_US"}
    calls = []

    def post(url, payload):
        calls.append(payload)
        assert url == "https://example.test/services/recruiting/v1/jobs"
        assert payload["sortBy"] == "date"
        index = payload["pageNumber"]
        row = {
            "id": str(1 if fault == "repeat" else index + 1),
            "unifiedStandardTitle": "Software Developer",
            "unifiedUrlTitle": "Software-Developer",
            "mfield1": ["Toronto, ON"],
            "unifiedStandardStart": None if fault == "date" else "10/1/26",
        }
        return {
            "totalJobs": 3 if fault == "count" and index else 2,
            "jobSearchResult": [] if fault == "empty" and index else [{"response": row}],
        }

    def fetch(url):
        if fault == "rate_limit":
            raise ValueError("http_429")
        identity = url.rsplit("/", 1)[1].split("-")[0]
        return (
            f'<script>jobID: {999 if fault == "identity" else identity},</script><span itemprop="title">Software Developer</span>'
            + (
                ""
                if fault == "description"
                else '<span itemprop="description">Overview</span><span itemprop="description">Full requirements</span>'
            )
        )

    jobs, health = discover_rmk("Example", plan, fetcher=fetch, poster=post)
    assert health["status"] == ("ok" if fault is None else "partial")
    if fault is None:
        assert len(jobs) == 2
        assert jobs[0]["description"] == "Overview\n\nFull requirements"
        assert jobs[0]["date_posted"] == "2026-10-01"
        assert len(calls) == 2
    if fault == "rate_limit":
        assert len(calls) == 1
    if fault in {"identity", "description"}:
        assert all(j["description"] is None for j in jobs)


def test_rmk_resolves_job_search_link_and_skips_old_detail_fetch():
    root = "https://example.test/"

    def fetch(url):
        return (
            '<a href="/search/?locale=en_US">Job Search</a>'
            if url == root
            else '<script src="https://successfactors.com/widget.js"></script><script>"xweb/rmk-jobs-search"</script>'
        )

    plan = resolve_career_fetch_plan(root, fetcher=fetch)
    assert plan == {"method": "rmk", "url": root + "search/?locale=en_US"}
    detail = Mock()
    jobs, health = discover_rmk(
        "Example",
        plan,
        fetcher=detail,
        poster=lambda *args: {
            "totalJobs": 1,
            "jobSearchResult": [
                {
                    "response": {
                        "id": "1",
                        "unifiedStandardTitle": "Software Developer",
                        "unifiedUrlTitle": "Software-Developer",
                        "mfield1": ["Toronto, ON"],
                        "unifiedStandardStart": "1/1/00",
                    }
                }
            ],
        },
        hours_old=24,
    )
    assert jobs == [] and health["status"] == "ok"
    detail.assert_not_called()
