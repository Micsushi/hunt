import json
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock
from urllib.error import HTTPError

import pytest

from hunter.discovery_sources import discover_company_career_site
from hunter.discovery_structured import discover_structured


def posting(**changes):
    return {
        "@type": "JobPosting",
        "title": "IT Support",
        "url": "/jobs/42",
        "description": "<p>Resolve hardware and software problems.</p>",
        "jobLocation": {"address": {"addressLocality": "Toronto", "addressCountry": "CA"}},
        "datePosted": datetime.now(UTC).date().isoformat(),
        **changes,
    }


def html(data, extra=""):
    return '<script type="application/ld+json">' + json.dumps(data) + "</script>" + extra


def test_company_preview_reports_choices_and_does_not_save():
    from hunter.company_preview import preview_company

    board = "https://boards.greenhouse.io/example"
    result = preview_company("Example", board, fetcher=lambda _: '{"jobs": []}')
    assert result["status"] == "ok" and result["matched"] == 0
    assert result["saved"] is False
    page = '<a href="https://boards.greenhouse.io/one">Jobs</a><a href="https://jobs.ashbyhq.com/two">Jobs</a>'
    result = preview_company("Example", "https://example.com/careers", fetcher=lambda _: page)
    assert result["status"] == "needs_setup"
    assert len(result["plan"]["boards"]) == 2
    with pytest.raises(ValueError):
        preview_company("Example", "javascript:alert(1)")


def test_unseen_employer_works_through_normal_discovery_without_company_rule():
    base = "https://never-seen.example/careers"
    pages = {
        base: '<a href="/jobs/42">IT Support</a>',
        "https://never-seen.example/jobs/42": html({"@graph": [posting()]}),
    }
    fetch = Mock(side_effect=pages.__getitem__)
    jobs, health = discover_company_career_site("Unseen employer", base, fetcher=fetch)
    assert len(jobs) == 1 and jobs[0]["location"] == "Toronto, Canada"
    assert jobs[0]["auto_apply_eligible"] is False
    assert jobs[0]["enrichment_status"] == "blocked"
    assert health["status"] == "partial" and health["error"] == "structured_data_coverage_only"
    assert fetch.call_count == 2  # Resolution and parsing share each fetched page.


def test_fallback_never_claims_full_catalog_or_crosses_origins():
    base = "https://unseen.example/careers"
    bad = [
        "https://other.example/job",
        "http://unseen.example/job",
        "//unseen.example:123/job",
        "javascript:alert(1)",
    ]
    first = html(
        [posting(), posting(), posting(url=bad[0])],
        '<a rel="next" href="?page=2">Next</a>'
        + "".join(f'<a href="{url}">IT Support</a>' for url in bad),
    )
    fetch = Mock(side_effect=[first, html(posting(url="/jobs/43"))])
    jobs, health = discover_structured(
        "Example", {"method": "structured", "url": base}, fetcher=fetch
    )
    assert len(jobs) == 2 and health["status"] == "partial"
    assert [c.args[0] for c in fetch.call_args_list] == [base, base + "?page=2"]
    jobs, health = discover_structured(
        "Example", {"method": "structured", "url": base}, fetcher=lambda _: first, max_pages=1
    )
    assert len(jobs) == 1 and health["error"] == "page_limit_reached"


def test_expired_foreign_and_old_jobs_are_filtered_without_inventing_missing_dates():
    old = (datetime.now(UTC) - timedelta(days=40)).date().isoformat()
    data = [
        posting(url="/expired", validThrough=old),
        posting(url="/old", datePosted=old),
        posting(url="/foreign", jobLocation={"address": {"addressCountry": "United States"}}),
        posting(url="/unknown", datePosted=None),
    ]
    jobs, health = discover_structured(
        "Example",
        {"method": "structured", "url": "https://example.test/jobs"},
        fetcher=lambda _: html(data),
        hours_old=336,
    )
    assert len(jobs) == 1 and jobs[0]["date_posted"] is None
    assert health["status"] == "partial"


@pytest.mark.parametrize("status", [404, 429])
def test_failed_detail_preserves_leads_and_continues_only_after_a_closed_posting(status):
    base = "https://example.test/jobs"
    index = html(posting(), '<a href="/closed">IT Support</a><a href="/open">Developer</a>')
    fetch = Mock(
        side_effect=[
            index,
            HTTPError(base + "/closed", status, "failed", {}, None),
            html(posting(url="/open")),
        ]
    )
    jobs, health = discover_structured(
        "Example", {"method": "structured", "url": base}, fetcher=fetch
    )
    assert health["status"] == "partial"
    if status == 429:
        assert len(jobs) == 1 and health["error"] == "http_429"
        assert fetch.call_count == 2
    else:
        assert len(jobs) == 2 and jobs[-1]["job_url"].endswith("/open")
        assert fetch.call_count == 3


def test_explicit_no_open_roles_is_not_confused_with_rolling_applications():
    from hunter.discovery_structured import discover_structured

    plan = {"method": "structured", "url": "https://example.com/careers"}
    jobs, health = discover_structured(
        "Example",
        plan,
        fetcher=lambda _: (
            "<h1>Open roles</h1><p>We don't have any open roles at the moment.</p><a href='/talent-pool'>Software engineer rolling applications</a>"
        ),
    )
    assert jobs == [] and health["status"] == "ok"
    _, unknown = discover_structured("Example", plan, fetcher=lambda _: "<h1>Open roles</h1>")
    assert unknown["status"] == "pending_manual"
