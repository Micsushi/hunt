import json
from datetime import UTC, datetime, timedelta
from unittest.mock import Mock
from urllib.error import HTTPError

import pytest
from bs4 import BeautifulSoup

from hunter.discovery_sources import _parse_date, discover_company_career_site
from hunter.discovery_structured import discover_structured
from hunter.job_posting import job_postings, posting_location


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


def test_microdata_job_keeps_nested_location_and_employment_types(monkeypatch):
    from hunter import config

    monkeypatch.setattr(config, "SEARCH_TERMS", {"education": ["teacher"]})
    monkeypatch.setattr(config, "DISCOVERY_COUNTRIES", ["United Kingdom"])
    page = """<article itemscope itemtype="https://schema.org/JobPosting">
      <h1 itemprop="title">Primary School Teacher</h1>
      <a itemprop="url" href="/jobs/teacher">Apply</a>
      <div itemprop="jobLocation" itemscope itemtype="https://schema.org/Place">
        <div itemprop="address" itemscope itemtype="https://schema.org/PostalAddress">
          <span itemprop="addressLocality">London</span>
          <meta itemprop="addressCountry" content="United Kingdom">
        </div>
      </div>
      <meta itemprop="employmentType" content="FULL_TIME">
      <meta itemprop="employmentType" content="PART_TIME">
      <p itemprop="description">Teach primary school students.</p>
    </article>"""
    jobs, health = discover_structured(
        "School",
        {"url": "https://school.example/careers", "method": "structured"},
        fetcher=lambda _: page,
    )
    assert len(jobs) == 1
    assert jobs[0]["location"] == "London, United Kingdom"
    assert jobs[0]["employment_type"] == "FULL_TIME;PART_TIME"
    assert jobs[0]["description"] == "Teach primary school students."
    assert health["status"] == "partial"


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


@pytest.mark.parametrize(
    "wrap",
    [
        lambda p: p,
        lambda p: [p],
        lambda p: {"@graph": [p]},
        lambda p: {"@type": "ItemList", "itemListElement": [{"@type": "ListItem", "item": p}]},
    ],
)
def test_shared_metadata_shapes(wrap):
    record = posting(**{"@type": ["Thing", "JobPosting"]})
    soup = BeautifulSoup(
        html(wrap(record)) + '<script type="application/ld+json">broken</script>', "html.parser"
    )
    assert job_postings(soup) == [record]
    assert posting_location(record) == "Toronto, Canada"
    assert posting_location({"applicantLocationRequirements": [{"name": "CA"}]}) == "Canada"


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


def test_single_detail_without_url_requires_visible_matching_heading():
    plan = {"method": "structured", "url": "https://example.test/job/42"}
    for heading, count in [("IT Support", 1), ("Careers", 0)]:
        jobs, _ = discover_structured(
            "Example", plan, fetcher=lambda _: html(posting(url=None), f"<h1>{heading}</h1>")
        )
        assert len(jobs) == count


def test_rate_limit_retains_saved_leads_and_stops_following_links():
    base = "https://example.test/jobs"
    fetch = Mock(
        side_effect=[
            html(posting(), '<a href="/second">IT Support</a><a href="/third">Developer</a>'),
            HTTPError(base, 429, "limit", {}, None),
        ]
    )
    jobs, health = discover_structured(
        "Example", {"method": "structured", "url": base}, fetcher=fetch
    )
    assert len(jobs) == 1 and health["error"] == "http_429"
    assert fetch.call_count == 2


def test_empty_unknown_page_is_not_success_and_cached_plan_can_run_again():
    plan = {"method": "structured", "url": "https://example.test/jobs"}
    jobs, health = discover_company_career_site(
        "Example", plan["url"], fetcher=lambda _: "<h1>Careers</h1>", resolved_plan=plan
    )
    assert jobs == [] and health["status"] == "pending_manual"


def test_static_metadata_does_not_start_a_browser():
    render = Mock(side_effect=AssertionError("Browser was unnecessary"))
    jobs, _ = discover_company_career_site(
        "New employer",
        "https://new.example/jobs",
        fetcher=lambda _: html(posting()),
        rendered_resolver=render,
    )
    assert len(jobs) == 1
    render.assert_not_called()


def test_bad_metadata_does_not_discard_later_jobs():
    plan = {"method": "structured", "url": "https://example.test/jobs"}
    jobs, health = discover_structured(
        "Example",
        plan,
        fetcher=lambda _: html(
            [
                posting(url="https://[invalid/job"),
                posting(url="/unknown-date", datePosted=1e100),
                posting(url="/valid"),
            ]
        ),
    )
    assert len(jobs) == 2
    assert jobs[0]["date_posted"] is None
    assert health["error"] == "structured_data_coverage_only"


def test_head_next_link_is_followed_without_anchor():
    base = "https://example.test/jobs"
    fetch = Mock(
        side_effect=[
            html(posting(), '<link rel="next" href="?page=2">'),
            html(posting(url="/jobs/43")),
        ]
    )
    jobs, health = discover_structured(
        "Example", {"method": "structured", "url": base}, fetcher=fetch
    )
    assert len(jobs) == 2
    assert health["status"] == "partial"
    assert fetch.call_args.args == (base + "?page=2",)


@pytest.mark.parametrize("value", [True, False, 1e100, float("nan"), float("inf"), -1e100])
def test_invalid_numeric_dates_remain_unknown(value):
    assert _parse_date(value) is None


def test_valid_numeric_dates_keep_seconds_and_milliseconds_support():
    expected = datetime(2026, 1, 1, tzinfo=UTC)
    assert _parse_date(expected.timestamp()) == expected
    assert _parse_date(expected.timestamp() * 1000) == expected


def test_custom_job_type_reaches_unknown_employer_and_keeps_its_category(monkeypatch):
    from hunter import config

    monkeypatch.setattr(config, "SEARCH_TERMS", {"healthcare": ["nurse"]})
    base = "https://unseen.example/careers"
    pages = {
        base: '<a href="/jobs/42">Registered Nurse</a>',
        "https://unseen.example/jobs/42": html(posting(title="Registered Nurse")),
    }
    jobs, health = discover_company_career_site("Unseen", base, fetcher=pages.__getitem__)
    assert len(jobs) == 1
    assert jobs[0]["category"] == "healthcare"
    assert jobs[0]["discovery_suppressed_reason"] is None
    assert health["status"] == "partial"


def test_broken_detail_does_not_prevent_later_postings():
    base = "https://unseen.example/careers"
    pages = {
        base: '<a href="/jobs/closed">IT Support</a><a href="/jobs/open">Developer</a>',
        "https://unseen.example/jobs/open": html(posting(url="/jobs/open")),
    }

    def fetch(url):
        if url not in pages:
            raise HTTPError(url, 404, "Gone", {}, None)
        return pages[url]

    jobs, health = discover_structured(
        "Unseen", {"method": "structured", "url": base}, fetcher=fetch
    )
    assert len(jobs) == 1
    assert jobs[0]["job_url"].endswith("/jobs/open")
    assert health["status"] == "partial"


def test_cached_structured_plan_rediscovers_new_platform():
    base = "https://unseen.example/careers"
    pages = {
        base: '<a href="https://boards.greenhouse.io/unseen">Open jobs</a>',
        "https://boards-api.greenhouse.io/v1/boards/unseen/jobs?content=true": json.dumps(
            {"jobs": []}
        ),
    }
    jobs, health = discover_company_career_site(
        "Unseen",
        base,
        fetcher=pages.__getitem__,
        resolved_plan={"method": "structured", "url": base},
    )
    assert health["method"] == "greenhouse"
    assert health["status"] == "ok"


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


def test_preview_explains_policy_exclusion_without_saving():
    from unittest.mock import patch

    from hunter.company_preview import preview_company

    jobs = [
        {
            "title": "Senior Software Engineer",
            "company": "Example",
            "location": "Canada",
            "job_url": "https://example.com/jobs/1",
            "category": "engineering",
        }
    ]
    with (
        patch(
            "hunter.company_preview.resolve_career_fetch_plan",
            return_value={"method": "greenhouse", "url": "https://example.com"},
        ),
        patch(
            "hunter.company_preview.discover_company_career_site",
            return_value=(jobs, {"status": "ok"}),
        ),
    ):
        result = preview_company("Example", "https://example.com")
    assert result["sample"][0]["discovery_suppressed_reason"] == "experienced_title"
    assert result["saved"] is False
