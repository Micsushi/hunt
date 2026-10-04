import json
from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, Mock
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pytest

from hunter.discovery_browser import (
    parse_eluta_results,
    parse_gc_jobs,
    parse_jobs_ca_results,
    read_jobs_ca_detail,
)
from hunter.discovery_jobright import discover_jobright, parse_jobright_page, save_jobright_session
from hunter.discovery_sources import (
    career_fetch_plan,
    catalog_company_sites,
    discover_builtin,
    discover_company_career_site,
    discover_job_bank,
    discover_jobillico,
    discover_public_feeds,
    discover_talentegg,
    discover_vanhack,
    discover_wellfound,
)


@pytest.mark.parametrize("fault", [None, "count", "duplicate", "identity", "description", "date"])
def test_peoplesoft_public_catalog_and_detail(fault):
    from hunter.discovery_peoplesoft import parse_catalog, posting_url, read_detail

    url = "https://careers.example.test/psc/EXT/EMPLOYEE/HRMS/c/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL?SiteId=2"
    plan = career_fetch_plan(url)
    assert plan["method"] == "peoplesoft"
    row_html = """<li class="ps_grid-row"><span id="SCH_JOB_TITLE$0">IT Developer</span>
      <span id="HRS_APP_JBSCH_I_HRS_JOB_OPENING_ID$0">1234</span>
      <span id="SCH_OPENED$0">2026/10/01</span></li>"""
    if fault == "date":
        row_html = row_html.replace("2026/10/01", "unknown")
    html = (
        '<div id="win0divHRS_SCH_WRK_FLU_HRS_SES_CNTS_MSG$70$"><b>1</b> jobs found.</div>'
        + row_html
    )
    if fault == "count":
        html = html.replace("<b>1</b>", "<b>0</b>")
    if fault == "duplicate":
        html += row_html
    if fault in {"count", "duplicate"}:
        with pytest.raises(ValueError, match="catalog_count_mismatch|catalog_repeated"):
            parse_catalog(html)
        return
    rows, total = parse_catalog(html)
    assert total == len(rows) == 1
    assert rows[0]["date_posted"] == (None if fault == "date" else "2026-10-01")
    target = posting_url(plan["url"], rows[0]["id"])
    assert "JobOpeningId=1234" in target and "SiteId=2" in target
    assert career_fetch_plan(target) == plan
    detail = """<span id="HRS_SCH_WRK2_HRS_JOB_OPENING_ID">1234</span>
      <span id="HRS_SCH_WRK2_POSTING_TITLE">IT Developer</span>
      <span id="HRS_SCH_WRK_HRS_DESCRLONG">Calgary, Alberta, Canada</span>
      <span id="HRS_SCH_WRK_DESCR100$0lbl">Qualifications</span>
      <span id="HRS_SCH_PSTDSC_DESCRLONG$0">Build Python services.</span>"""
    if fault == "identity":
        detail = detail.replace(">1234<", ">9999<")
    if fault == "description":
        detail = detail.replace('id="HRS_SCH_PSTDSC_DESCRLONG$0"', 'id="other"')
    if fault in {"identity", "description"}:
        with pytest.raises(ValueError, match="detail_identity_mismatch|description_not_found"):
            read_detail(detail, rows[0])
        return
    description, location = read_detail(detail, rows[0])
    assert "Qualifications" in description and "Build Python services." in description
    assert location == "Calgary, Alberta, Canada"


def test_peoplesoft_catalog_reports_unloaded_rows_and_accepts_explicit_empty():
    from hunter.discovery_peoplesoft import parse_catalog

    for count in (0, 101):
        rows, total = parse_catalog(
            f'<div id="win0divHRS_SCH_WRK_FLU_HRS_SES_CNTS_MSG">{count} jobs found.</div>'
        )
        assert rows == [] and total == count
    with pytest.raises(ValueError, match="catalog_total_unknown"):
        parse_catalog("<h1>Careers</h1>")


def test_peoplesoft_subsidiary_share_url_must_match_posting_and_origin():
    from hunter.discovery_peoplesoft import read_share_url
    from hunter.discovery_policy import canonical_job_key

    origin = "https://careers.example.test/psc/EXT/EMPLOYEE/HRMS/c/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL"
    target = origin + "?Page=HRS_APP_JBPST_FL&SiteId=5&JobOpeningId=1234&PostingSeq=1"
    assert read_share_url(f"<p>{target}</p>", origin, "1234") == target
    assert canonical_job_key(target) == canonical_job_key(target.replace("SiteId=5", "SiteId=2"))
    assert canonical_job_key(target) != canonical_job_key(target.replace("1234", "5678"))
    for wrong in (
        target.replace("1234", "9999"),
        target.replace("careers.example.test", "foreign.test"),
    ):
        with pytest.raises(ValueError, match="posting_url_unverified"):
            read_share_url(f"<p>{wrong}</p>", origin, "1234")


@pytest.mark.parametrize("fault", [None, "incomplete", "changed", "rate_limit"])
def test_peoplesoft_browser_scrolls_to_total_and_reports_failures(monkeypatch, fault):
    from hunter.discovery_peoplesoft import discover_peoplesoft

    plan = career_fetch_plan(
        "https://careers.example.test/psc/EXT/EMPLOYEE/HRMS/c/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL?SiteId=2"
    )

    def catalog(ids, total=2):
        return (
            f'<div id="win0divHRS_SCH_WRK_FLU_HRS_SES_CNTS_MSG"><b>{total}</b> jobs found.</div>'
            + "".join(
                f'<li class="ps_grid-row"><span id="SCH_JOB_TITLE${i}">IT Developer</span>'
                f'<span id="HRS_APP_JBSCH_I_HRS_JOB_OPENING_ID${i}">{identity}</span>'
                f'<span id="SCH_OPENED${i}">2026/10/01</span></li>'
                for i, identity in enumerate(ids)
            )
        )

    def detail(identity):
        return (
            f'<span id="HRS_SCH_WRK2_HRS_JOB_OPENING_ID">{identity}</span>'
            + """
          <span id="HRS_SCH_WRK2_POSTING_TITLE">IT Developer</span>
          <span id="HRS_SCH_PSTDSC_DESCRLONG$0">Build Python services.</span>"""
        )

    context = MagicMock()
    browser = context.__enter__.return_value.chromium.launch.return_value
    page = browser.new_page.return_value
    page.title.return_value = "Careers"
    page.get_by_text.return_value.is_visible.return_value = False
    page.locator.return_value.is_visible.return_value = False

    def navigate(url, **kwargs):
        page.url = url
        return Mock(status=429 if fault == "rate_limit" and "JobOpeningId=" in url else 200)

    page.goto.side_effect = navigate
    content = [catalog(["1"])]
    if fault == "incomplete":
        page.wait_for_function.side_effect = TimeoutError()
    else:
        content.append(catalog(["1", "2"], 3 if fault == "changed" else 2))
    content.extend([detail("1"), detail("2")])
    page.content.side_effect = content
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: context)
    jobs, health = discover_peoplesoft("Example", plan)
    assert health["status"] == ("ok" if fault is None else "partial")
    assert len(jobs) == (1 if fault in {"incomplete", "rate_limit"} else 2)
    assert (
        health["error"]
        == {
            None: None,
            "incomplete": "pagination_incomplete",
            "changed": "catalog_changed_during_scan",
            "rate_limit": "http_429",
        }[fault]
    )
    page.wait_for_function.assert_called_once()
    browser.close.assert_called_once()
    assert all("JobOpeningId=" in job["job_url"] for job in jobs)
    if fault == "rate_limit":
        assert page.goto.call_count == 2
        assert jobs[0]["description"] is None

    assert health["catalog_complete"] == (fault in {None, "rate_limit"})


@pytest.mark.parametrize("fault", [None, "tenant", "foreign", "identity", "description", "repeat"])
def test_paycor_public_reader_preserves_unverified_coverage(fault):
    from hunter.discovery_paycor import discover_paycor

    tenant, identity = "a" * 32, "b" * 32
    root = f"https://recruitingbypaycor.com/career/CareerHome.action?clientId={tenant}"
    target = f"https://recruitingbypaycor.com/career/JobIntroduction.action?clientId={tenant}&id={identity}"
    card = (
        '<div class="gnewtonCareerGroupRowClass"><div class="gnewtonCareerGroupJobTitleClass">'
        f'<a href="{target if fault != "foreign" else target.replace("recruitingbypaycor.com", "evil.test")}">Software Engineer</a></div>'
        '<div class="gnewtonCareerGroupJobDescriptionClass">Burnaby, British Columbia</div></div>'
    )
    calls = []

    def fetch(url):
        calls.append(url)
        if url == root:
            return (
                f'<form name="candidateHome"><input name="clientId" value="{tenant if fault != "tenant" else "other"}">'
                + card * (2 if fault == "repeat" else 1)
                + "</form>"
            )
        assert url == target
        return (
            f'<form id="gravityApplyJob" action="/career/SubmitResume.action?clientId={tenant}&id={identity if fault != "identity" else "c" * 32}"></form>'
            '<td id="gnewtonJobPosition"><b>Position:</b> Software Engineer</td>'
            '<td id="gnewtonJobLocationInfo">Burnaby, British Columbia</td>'
            f'<td id="gnewtonJobDescriptionText">{"Full requirements" if fault != "description" else ""}</td>'
        )

    plan = career_fetch_plan(root)
    assert plan["method"] == "paycor"
    jobs, health = discover_paycor("Example", plan, fetcher=fetch)
    assert health["status"] == ("failed" if fault in {"tenant", "foreign"} else "partial")
    assert not any("SubmitResume" in url or "evil.test" in url for url in calls)
    if fault is None:
        assert len(jobs) == 1 and jobs[0]["description"] == "Full requirements"
        assert jobs[0]["date_posted"] is None
        assert health["error"] == "catalog_total_unknown"
    elif fault in {"identity", "description"}:
        assert jobs[0]["description"] is None


@pytest.mark.parametrize("fault", [None, "count", "repeat", "foreign", "identity", "description"])
def test_hrsmart_reads_all_public_pages_and_validates_detail_identity(fault):
    from hunter.discovery_hrsmart import discover_hrsmart

    root = "https://example.hua.hrsmart.com/hr/ats/JobSearch/viewAll"
    calls = []

    def fetch(url):
        calls.append(url)
        if "JobSearch" in url:
            page = 2 if "page:2" in url else 1
            identity = 1 if fault == "repeat" else page
            total = 3 if fault == "count" and page == 2 else 2
            link = "/hr/ats/JobSearch/viewAll/jobSearchPaginationExternal_page:2"
            if fault == "foreign":
                link = "https://evil.test" + link
            return (
                f"<p>Displaying {page} - {page} of {total}</p>"
                '<table id="jobSearchResultsGrid_table"><tr><th>Req. #</th><th>Job Title</th><th>Location</th><th>Date Opened</th></tr>'
                f'<tr><td>{identity}</td><td><a href="/hr/ats/Posting/view/{identity}">IT Support</a></td><td>Victoria, BC, CA</td><td>10/1/2026</td></tr></table>'
                + (f'<a class="paginateNext" href="{link}">Next</a>' if page == 1 else "")
            )
        identity = url.rsplit("/", 1)[-1]
        return (
            f"<h2>IT Support - ({'999' if fault == 'identity' else identity})</h2>"
            '<div id="job_details_ats_requisition_title">IT Support</div>'
            f'<div id="job_details_ats_requisition_description">{"Full description" if fault != "description" else ""}</div>'
        )

    jobs, health = discover_hrsmart("Example", career_fetch_plan(root), fetcher=fetch)
    assert health["catalog_complete"] == (fault in {None, "identity", "description"})
    assert health["status"] == ("ok" if fault is None else "partial")
    assert not any("evil.test" in url for url in calls)
    if fault is None:
        assert len(jobs) == 2 and len(calls) == 4
        assert all(
            job["date_posted"] == "2026-10-01" and job["description"] == "Full description"
            for job in jobs
        )
    elif fault in {"count", "repeat", "foreign"}:
        assert len(jobs) == 1


def test_successfactors_skips_old_details_without_stopping_catalog_pagination():
    from hunter.discovery_sources import discover_successfactors

    root = "https://careers.example.com/search/"
    old_date = (datetime.now(UTC) - timedelta(days=30)).strftime("%b %d, %Y")
    recent_date = datetime.now(UTC).strftime("%b %d, %Y")
    calls = []

    def fetch(url):
        calls.append(url)
        if "/search/" in url:
            first = "startrow=" not in url
            identity, date = ("old", old_date) if first else ("recent", recent_date)
            return (
                '<div id="searchresults"><table><tr class="data-row">'
                f'<td><a class="jobTitle-link" href="/job/{identity}">IT Support</a>'
                f'<span class="jobLocation">Toronto, Canada</span><span class="jobDate">{date}</span></td>'
                "</tr></table></div>" + ('<a href="?startrow=25">Next</a>' if first else "")
            )
        assert url == "https://careers.example.com/job/recent"
        return '<div itemprop="description">Overview</div><div itemprop="description">Full requirements</div>'

    jobs, health = discover_successfactors(
        "Example", {"method": "successfactors", "url": root}, fetcher=fetch, hours_old=336
    )
    assert health["status"] == "ok" and len(jobs) == 1
    assert len(calls) == 3 and not any("/job/old" in url for url in calls)
    assert jobs[0]["description"] == "Overview\n\nFull requirements"


@pytest.mark.parametrize(
    "fault", [None, "count", "repeat", "foreign", "identity", "description", "date"]
)
def test_apple_public_pages_reconcile_catalog_cards_and_details(fault):
    from hunter.discovery_apple import discover_apple

    root = "https://jobs.apple.com/en-ca/search?location=canada-CANC"
    calls = []

    def render(data, cards=""):
        return (
            cards
            + "<script>window.__staticRouterHydrationData = JSON.parse("
            + json.dumps(json.dumps({"loaderData": data}))
            + ");</script>"
        )

    def fetch(url):
        calls.append(url)
        if "/search?" in url:
            page = 2 if "page=2" in url else 1
            identity = "1" if fault == "repeat" else str(page)
            row = {
                "id": "PIPE-1" if page == 1 else identity,
                "positionId": identity,
                "type": "PIPE",
                "postingTitle": "Software Engineer",
                "postExternal": True,
                "locations": [{"name": "Toronto", "countryName": "Canada"}],
            }
            target = f"/en-ca/details/{identity}/software-engineer"
            if fault == "foreign" and page == 2:
                target = "https://evil.test" + target
            return render(
                {
                    "search": {
                        "searchResults": [row],
                        "totalRecords": 3 if fault == "count" and page == 2 else 2,
                        "page": page,
                        "queryParams": {"location": "canada-CANC"},
                    }
                },
                f'<h3><a href="{target}">Software Engineer</a></h3>',
            )
        identity = urlsplit(url).path.split("/")[3]
        return render(
            {
                "jobDetails": {
                    "jobsData": {
                        "jobNumber": "999" if fault == "identity" else identity,
                        "postingTitle": "Software Engineer",
                        "description": "" if fault == "description" else "Build software",
                        "minimumQualifications": "Python skills",
                        "preferredQualifications": "SQL skills",
                        "postDateInGMT": None if fault == "date" else "2026-10-01T00:00:00Z",
                        "locations": [{"name": "Toronto", "countryName": "Canada"}],
                    }
                }
            }
        )

    jobs, health = discover_apple("Apple", career_fetch_plan(root), fetcher=fetch)
    assert health["catalog_complete"] == (fault in {None, "identity", "description", "date"})
    assert health["status"] == ("ok" if fault is None else "partial")
    assert not any("evil.test" in url for url in calls)
    if fault is None:
        assert len(jobs) == 2 and len(calls) == 4
        assert all(
            "Python skills" in job["description"] and "SQL skills" in job["description"]
            for job in jobs
        )
        assert all(job["date_posted"] == "2026-10-01" for job in jobs)
    if fault in {"count", "repeat", "foreign"}:
        assert len(jobs) == 1


@pytest.mark.parametrize(
    "fault", [None, "count", "repeat", "foreign", "identity", "date", "description"]
)
def test_eightfold_shared_reader_pages_details_and_failure_preservation(fault):
    from hunter.discovery_eightfold import discover_eightfold
    from hunter.discovery_sources import resolve_career_fetch_plan

    base = "https://careers.example.com"
    page = '<script>window._EF_GROUP_ID = "example.com";</script><script src="/gen/js/pcsxPwa.abc.js"></script>'
    plan = resolve_career_fetch_plan(base, fetcher=lambda _: page)
    assert plan == {"method": "eightfold", "url": base, "domain": "example.com"}
    calls = []

    def fetch(url):
        calls.append(url)
        query = parse_qs(urlsplit(url).query)
        identity = query.get("position_id", [str(int(query.get("start", ["0"])[0]) + 1)])[0]
        row = {
            "id": int(identity),
            "atsJobId": "ref" + identity,
            "name": "Software Engineer",
            "locations": ["Toronto,Ontario,Canada"],
            "positionUrl": "/careers/job/" + identity,
            "publicUrl": base + "/careers/job/" + identity,
            "postedTs": 1790814308,
            "jobDescription": "<p>Full software role requirements.</p>",
        }
        if urlsplit(url).path.endswith("/search"):
            if fault == "repeat":
                row.update(id=1, positionUrl="/careers/job/1")
            if fault == "foreign" and identity == "2":
                row["positionUrl"] = "https://evil.test/careers/job/2"
            return json.dumps(
                {
                    "status": 200,
                    "data": {
                        "positions": [row],
                        "count": 3 if fault == "count" and identity == "2" else 2,
                    },
                }
            )
        if fault == "identity":
            row["id"] = 999
        if fault == "date":
            row["postedTs"] = None
        if fault == "description":
            row["jobDescription"] = ""
        return json.dumps({"status": 200, "data": row})

    jobs, health = discover_eightfold("Example", plan, fetcher=fetch)
    assert health["catalog_complete"] == (fault in {None, "identity", "description", "date"})
    assert health["status"] == ("ok" if fault is None else "partial")
    assert len([u for u in calls if "/search?" in u]) == 2
    assert not any("evil.test" in u for u in calls)
    if fault is None:
        assert len(jobs) == 2
        assert all(j["description"] == "Full software role requirements." for j in jobs)
    if fault in {"count", "repeat", "foreign"}:
        assert len(jobs) == 1


@pytest.mark.parametrize(
    "fault",
    [
        None,
        "count",
        "repeat",
        "foreign",
        "identity",
        "date",
        "description",
        "expired",
        "closed",
        "encoded",
    ],
)
def test_capgemini_pages_and_verifies_full_postings(fault):
    from hunter.discovery_capgemini import discover_capgemini

    plan = career_fetch_plan("https://www.capgemini.com/ca-en/careers/")
    assert plan["method"] == "capgemini"
    calls = []

    def fetch(url):
        calls.append(url)
        if "/api/job-search" in url:
            page = int(parse_qs(urlsplit(url).query)["page"][0])
            identity = 1 if fault == "repeat" else page
            target = f"https://careers.capgemini.com/job/Developer/{identity}/"
            if fault == "encoded":
                target = target.replace("Developer", "Developer's")
            if fault == "foreign" and page == 2:
                target = target.replace("careers.capgemini.com", "evil.test")
            return json.dumps(
                {
                    "total": 3 if fault == "count" and page == 2 else 2,
                    "count": 2,
                    "data": [
                        {
                            "id": str(identity),
                            "apply_job_url": target,
                            "country_code": "en-ca",
                            "title": "Software Developer",
                            "status": "1",
                            "location": "Toronto",
                        }
                    ],
                }
            )
        identity = urlsplit(url).path.rstrip("/").rsplit("/", 1)[-1]
        if fault == "closed":
            return "<strong>Sorry, this position has been filled.</strong>"
        title = "Other title" if fault == "identity" and identity == "2" else "Software Developer"
        posted = datetime.now(UTC).strftime("%a %b %d %H:%M:%S UTC %Y")
        date = "" if fault == "date" else f'<meta itemprop="datePosted" content="{posted}">'
        content = (
            ""
            if fault == "description"
            else '<div itemprop="description">Full software role requirements.</div>'
        )
        expires = (
            '<meta itemprop="validThrough" content="Wed Jan 01 00:00:00 UTC 2020">'
            if fault == "expired"
            else ""
        )
        return (
            f'<link rel="canonical" href="{url.replace(chr(39), "&amp;apos;")}"><h1>{title}</h1>'
            f'<meta itemprop="addressCountry" content="CA">{date}{content}{expires}'
        )

    jobs, health = discover_capgemini("Capgemini", plan, fetcher=fetch)
    assert health["status"] == (
        "ok" if fault in {None, "expired", "closed", "encoded"} else "partial"
    )
    assert len([u for u in calls if "/api/job-search" in u]) == 2
    assert not any("evil.test" in u for u in calls)
    if fault in {None, "encoded"}:
        assert len(jobs) == 2
        assert all(j["description"] == "Full software role requirements." for j in jobs)
    elif fault in {"expired", "closed"}:
        assert jobs == []
    elif fault in {"count", "repeat", "foreign"}:
        assert len(jobs) == 1


def test_bamboohr_embed_resolves_without_running_script():
    from hunter.discovery_sources import resolve_career_fetch_plan

    root = "https://example.com/careers"
    embed = '<script src="https://example.bamboohr.com/js/embed.js"></script>'
    assert resolve_career_fetch_plan(root, fetcher=lambda _: embed) == {
        "method": "bamboohr",
        "url": "https://example.bamboohr.com/careers",
    }
    for invalid in (
        embed.replace("bamboohr.com", "bamboohr.com.evil.test"),
        embed.replace("/js/embed.js", "/js/other.js"),
        embed.replace("https:", "http:"),
    ):
        assert resolve_career_fetch_plan(root, fetcher=lambda _: invalid)["method"] == "manual"
    ambiguous = embed + embed.replace("example.bamboohr", "other.bamboohr")
    assert resolve_career_fetch_plan(root, fetcher=lambda _: ambiguous)["error"] == (
        "ambiguous_career_boards"
    )


def test_rendered_career_fallback_only_for_unresolved_public_pages():
    renderer = Mock(return_value={"method": "greenhouse", "url": "https://catalog.example/jobs"})

    def fetcher(url):
        return '{"jobs": []}' if "catalog.example" in url else "<html></html>"

    jobs, health = discover_company_career_site(
        "Example", "https://example.com/careers", fetcher=fetcher, rendered_resolver=renderer
    )
    assert jobs == [] and health["status"] == "ok"
    renderer.assert_called_once_with("https://example.com/careers")
    renderer.reset_mock()
    discover_company_career_site(
        "Example",
        "https://jobs.lever.co/example",
        fetcher=lambda _: "[]",
        rendered_resolver=renderer,
    )
    discover_company_career_site(
        "Example",
        "https://example.com/careers",
        fetcher=lambda _: (
            '<a href="https://jobs.lever.co/one">One</a><a href="https://jobs.lever.co/two">Two</a>'
        ),
        rendered_resolver=renderer,
    )
    discover_company_career_site(
        "Example",
        "https://example.com/careers",
        fetcher=Mock(side_effect=HTTPError("https://example.com", 403, "Forbidden", {}, None)),
        rendered_resolver=renderer,
    )
    renderer.assert_not_called()


@pytest.mark.parametrize("failed", [False, True])
def test_rendered_career_browser_is_isolated_and_closed(monkeypatch, failed):
    from hunter.discovery_browser import resolve_rendered_career_fetch_plan

    manager = MagicMock()
    browser = manager.return_value.__enter__.return_value.chromium.launch.return_value
    page = browser.new_page.return_value
    page.goto.return_value.status = 200
    page.title.return_value = "Careers"
    page.content.return_value = '<a href="https://jobs.lever.co/example">Open jobs</a>'
    page.get_by_role.return_value.first.count.return_value = 1
    monkeypatch.setattr("playwright.sync_api.sync_playwright", manager)
    if failed:
        page.goto.side_effect = RuntimeError("navigation failed")
        with pytest.raises(RuntimeError, match="navigation failed"):
            resolve_rendered_career_fetch_plan("https://example.com/careers")
    else:
        assert (
            resolve_rendered_career_fetch_plan("https://example.com/careers")["method"] == "lever"
        )
        page.get_by_role.return_value.first.scroll_into_view_if_needed.assert_called_once()
    manager.return_value.__enter__.return_value.chromium.launch.assert_called_once_with(
        headless=True
    )
    browser.close.assert_called_once()


@pytest.mark.parametrize("case", ["valid", "denied", "lookalike", "detail", "ambiguous"])
def test_rendered_career_resolves_only_public_catalog_responses(monkeypatch, case):
    from hunter.discovery_browser import resolve_rendered_career_fetch_plan

    manager = MagicMock()
    browser = manager.return_value.__enter__.return_value.chromium.launch.return_value
    page = browser.new_page.return_value
    page.title.return_value = "Careers"
    page.content.return_value = "<main>Open jobs</main>"
    url = "https://boards-api.greenhouse.io/v1/boards/example/jobs"
    if case == "lookalike":
        url = url.replace("greenhouse.io", "greenhouse.io.attacker.test")
    if case == "detail":
        url += "/42"

    def navigate(*args, **kwargs):
        listener = page.on.call_args.args[1]
        listener(
            Mock(
                url=url,
                status=403 if case == "denied" else 200,
                request=Mock(method="GET", resource_type="fetch"),
            )
        )
        if case == "ambiguous":
            listener(
                Mock(
                    url=url.replace("example", "other"),
                    status=200,
                    request=Mock(method="GET", resource_type="xhr"),
                )
            )
        return Mock(status=200)

    page.goto.side_effect = navigate
    monkeypatch.setattr("playwright.sync_api.sync_playwright", manager)
    plan = resolve_rendered_career_fetch_plan("https://example.com/careers")
    assert plan["method"] == ("greenhouse" if case == "valid" else "manual")
    if case == "valid":
        assert plan["url"] == url + "?content=true"
    if case == "ambiguous":
        assert plan["error"] == "ambiguous_career_boards"
    browser.close.assert_called_once()


def test_ibm_confirmed_closed_page_is_not_a_live_posting(monkeypatch):
    import playwright.sync_api

    from hunter.discovery_ibm import is_ibm_closed_page, read_ibm_details

    html = "<h2>Sorry, this job is closed and we are no longer accepting applications - but let's keep in touch!</h2>"
    assert is_ibm_closed_page("https://careers.ibm.com/en_US/closedjob", html)
    assert not is_ibm_closed_page("https://careers.ibm.com/en_US/careers/JobDetail?jobId=1", html)
    assert not is_ibm_closed_page("https://attacker.test/en_US/closedjob", html)
    assert not is_ibm_closed_page(
        "https://careers.ibm.com/en_US/closedjob", "<h2>Service unavailable</h2>"
    )
    runtime = MagicMock()
    browser = runtime.__enter__.return_value.chromium.launch.return_value
    page = browser.new_page.return_value
    page.goto.return_value = Mock(status=200)
    page.url = "https://careers.ibm.com/en_US/closedjob"
    page.content.return_value = html
    monkeypatch.setattr(playwright.sync_api, "sync_playwright", lambda: runtime)
    jobs = [{"job_url": "https://careers.ibm.com/careers/JobDetail?jobId=1"}]
    assert read_ibm_details(jobs) is None
    assert jobs == []
    browser.close.assert_called_once()


@pytest.mark.parametrize(
    "status,title,error",
    [(403, "Forbidden", "http_403"), (200, "Just a moment", "security_checkpoint")],
)
def test_rendered_access_restrictions_remain_explicit(monkeypatch, status, title, error):
    from hunter.discovery_browser import resolve_rendered_career_fetch_plan

    manager = MagicMock()
    browser = manager.return_value.__enter__.return_value.chromium.launch.return_value
    page = browser.new_page.return_value
    page.goto.return_value.status = status
    page.title.return_value = title
    monkeypatch.setattr("playwright.sync_api.sync_playwright", manager)
    jobs, health = discover_company_career_site(
        "Example",
        "https://example.com/careers",
        fetcher=lambda _: "<html></html>",
        rendered_resolver=resolve_rendered_career_fetch_plan,
    )
    assert jobs == [] and health["status"] == "failed" and health["error"] == error
    browser.close.assert_called_once()


def test_feed_error_page_is_not_reported_as_empty_success():
    feeds = {"feed": ("markdown", "https://example.com/feed")}
    jobs, health = discover_public_feeds(
        hours_old=336, feeds=feeds, fetcher=lambda _: "<html>Temporarily unavailable</html>"
    )
    assert jobs == [] and health[0]["status"] == "failed"
    jobs, health = discover_public_feeds(
        hours_old=336,
        feeds=feeds,
        fetcher=lambda _: "| Company | Role | Location | Apply | Date Posted |",
    )
    assert jobs == [] and health[0]["status"] == "ok"


@pytest.mark.parametrize("fault", [None, "repeat", "wrong_offset", "empty", "detail_error"])
def test_oracle_public_catalog_pagination_details_and_partial_retention(fault):
    board = "https://example.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1"
    rows = [
        {
            "Id": "1",
            "Title": "IT Support",
            "PrimaryLocation": "Toronto",
            "PrimaryLocationCountry": "CA",
        },
        {
            "Id": "2",
            "Title": "Software Engineer",
            "PrimaryLocation": "Tijuana, BC, Mexico",
            "PrimaryLocationCountry": "MX",
        },
        {
            "Id": "3",
            "Title": "Software Developer",
            "PrimaryLocation": "Austin, United States",
            "PrimaryLocationCountry": "US",
            "secondaryLocations": [{"Name": "Montreal", "CountryCode": "CA"}],
        },
        {"Id": "4", "Title": "Expired IT Support", "PrimaryLocation": "Toronto, Canada"},
    ]
    offsets = []

    def fetch(url):
        if url == "https://example.com/careers":
            return f'<a href="{board}">Open jobs</a>'
        query = parse_qs(urlsplit(url).query)
        finder = query["finder"][0]
        if "recruitingCEJobRequisitionDetails?" in url:
            identity = finder.split('Id="')[1].split('"')[0]
            if fault == "detail_error" and identity == "3":
                raise HTTPError(url, 503, "Unavailable", {}, None)
            detail = {
                **rows[int(identity) - 1],
                "ExternalDescriptionStr": "<p>Full job duties</p>",
                "ExternalQualificationsStr": "<p>Required skills</p>",
                "ExternalPostedStartDate": "2026-10-01T12:00:00Z",
            }
            if identity == "4":
                detail["ExternalPostedEndDate"] = "2020-01-01T00:00:00Z"
            return json.dumps({"items": [detail]})
        offset = int(finder.split("offset=")[1])
        offsets.append(offset)
        page = rows[offset : offset + 2]
        if offset and fault == "repeat":
            page = rows[:2]
        if offset and fault == "empty":
            page = []
        return json.dumps(
            {
                "items": [
                    {
                        "SiteNumber": "CX_1",
                        "Location": "Canada",
                        "Offset": 0 if fault == "wrong_offset" else offset,
                        "TotalJobsCount": 4,
                        "requisitionList": page,
                    }
                ],
                "hasMore": False,
            }
        )

    jobs, health = discover_company_career_site(
        "Example", "https://example.com/careers", fetcher=fetch
    )
    assert offsets == [0, 2]
    assert health["method"] == "oracle_hcm"
    assert health["status"] == ("ok" if fault is None else "partial")
    assert len(jobs) == (2 if fault in {None, "detail_error"} else 1)
    assert "Required skills" in jobs[0]["description"]
    assert jobs[0]["date_posted"] == "2026-10-01"
    assert jobs[0]["enrichment_status"] == "blocked"
    assert jobs[0]["auto_apply_eligible"] is False
    if fault == "detail_error":
        assert jobs[1]["description"] is None and health["error"] == "http_503"
    if fault is None:
        assert "Montreal, Canada" in jobs[1]["location"]


@pytest.mark.parametrize("fault", [None, "detail_error", "identity", "count", "duplicate"])
def test_bamboohr_public_catalog_details_and_incomplete_health(fault):
    board = "https://example.bamboohr.com/careers"
    rows = [
        {
            "id": str(i),
            "jobOpeningName": f"IT Support {i}",
            "location": {"city": "Vancouver", "state": "British Columbia"},
        }
        for i in range(1, 5)
    ]
    # An explicit job country takes priority over an employer office address.
    rows[3]["atsLocation"] = {"country": "Mexico", "city": "Tijuana", "state": "BC"}
    if fault == "duplicate":
        rows.append(rows[0])

    def fetch(url):
        if url == board + "/list":
            return json.dumps(
                {"meta": {"totalCount": len(rows) + (fault == "count")}, "result": rows}
            )
        identity = url.split("/")[-2]
        assert identity != "4"
        if fault == "detail_error" and identity == "2":
            raise HTTPError(url, 503, "Unavailable", {}, None)
        detail = {
            **rows[int(identity) - 1],
            "jobOpeningName": f" IT Support {identity} ",
            "jobOpeningShareUrl": board
            + "/"
            + ("99" if fault == "identity" and identity == "2" else identity),
            "jobOpeningStatus": "Closed" if identity == "3" else "Open",
            "description": "<p>Support our internal IT systems.</p>",
            "datePosted": "2026-09-24",
        }
        return json.dumps({"result": {"jobOpening": detail}})

    jobs, health = discover_company_career_site("Example", board, fetcher=fetch)
    assert health["status"] == ("ok" if fault is None else "partial")
    assert len(jobs) == 2 and jobs[0]["date_posted"] == "2026-09-24"
    assert jobs[0]["description"] == "Support our internal IT systems."
    assert jobs[0]["enrichment_status"] == "blocked" and jobs[0]["auto_apply_eligible"] is False
    if fault in {"detail_error", "identity"}:
        assert jobs[1]["description"] is None


def test_oracle_vanity_domain_uses_published_site_configuration():
    from hunter.discovery_sources import resolve_career_fetch_plan

    html = '<base href="/en/sites/jobsearch" data-apibaseurl="https://example.fa.us2.oraclecloud.com:443" data-sitenumber="CX_45001">'
    assert resolve_career_fetch_plan(
        "https://careers.example.com/jobs", fetcher=lambda _: html
    ) == {
        "method": "oracle_hcm",
        "url": "https://example.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001",
    }
    assert (
        resolve_career_fetch_plan(
            "https://careers.example.com/jobs",
            fetcher=lambda _: html.replace("oraclecloud.com", "oraclecloud.com.evil.example"),
        )["method"]
        == "manual"
    )


def test_known_workday_host_moves_preserve_board():
    assert career_fetch_plan("https://cmu.wd5.myworkdayjobs.com/CMU/job/Old") == {
        "method": "workday",
        "url": "https://cmu.wd115.myworkdayjobs.com/wday/cxs/cmu/CMU",
    }
    assert career_fetch_plan("https://comcast.wd5.myworkdayjobs.com/en-US/Comcast_Careers")[
        "url"
    ].endswith("/comcast/Comcast_Careers")


def test_company_catalog_reuses_employer_not_historical_job_status(tmp_path):
    (tmp_path / "wd_test_jobs.csv").write_text(
        "company name,link,test status\nExample,https://example.wd3.myworkdayjobs.com/External/job/Canada/Old_R1,closed\n",
        encoding="utf-8",
    )
    sites = catalog_company_sites(tmp_path)
    assert list(sites) == ["Example"]
    jobs, health = discover_company_career_site(
        "Example", sites["Example"], poster=lambda *_: {"total": 0, "jobPostings": []}
    )
    assert jobs == [] and health["status"] == "ok"


def test_company_failure_isolated_and_old_dates_filtered(monkeypatch):
    from hunter import scraper

    monkeypatch.setattr(scraper, "set_runtime_state", Mock())

    monkeypatch.setattr(
        scraper,
        "COMPANY_CAREER_SITES",
        {"Good": "https://example.com", "Broken": "https://broken.example.com"},
    )
    monkeypatch.setattr(scraper, "upsert_company_fetch_queue", Mock())
    record = Mock()
    monkeypatch.setattr(scraper, "record_company_fetch_result", record)
    monkeypatch.setattr(scraper, "record_discovery_source_health", Mock())

    def discover(company, url, **kwargs):
        if company == "Broken":
            raise TimeoutError()
        return [{"date_posted": "2000-01-01"}, {"date_posted": None}], {"status": "ok"}

    monkeypatch.setattr(scraper, "discover_company_career_site", discover)
    batches = []
    assert scraper._discover_company_queue(on_result=batches.extend) == []
    assert batches == [{"date_posted": None}]
    record.assert_any_call(
        "Broken",
        coverage={
            "catalog": "unverified",
            "matched": 0,
            "descriptions": 0,
            "dates": 0,
            "verified_applications": 0,
        },
        state="failed",
        lead_count=0,
        error="TimeoutError",
        fetch_method=None,
        resolved_url=None,
    )


def test_greenhouse_update_time_is_not_posting_time_and_bad_catalog_is_not_empty():
    payload = {
        "jobs": [
            {
                "title": "IT Support",
                "absolute_url": "https://boards.greenhouse.io/example/jobs/42",
                "location": {"name": "Toronto"},
                "updated_at": "2026-10-01T12:00:00Z",
            }
        ]
    }
    jobs, _ = discover_company_career_site(
        "Example", "https://boards.greenhouse.io/example", fetcher=lambda _: json.dumps(payload)
    )
    assert jobs[0]["date_posted"] is None
    jobs, health = discover_company_career_site(
        "Example", "https://boards.greenhouse.io/example", fetcher=lambda _: "{}"
    )
    assert jobs == [] and health["status"] == "failed"


def test_gc_closing_date_is_not_posting_date():
    html = """<li class="searchResult"><strong><a href="/psrs-srfp/applicant/page1800?poster=42">IT Support Analyst</a></strong>
    <div class="tableCell">Closing date: 2099-01-01<br>Example Department<br>Ottawa (Ontario)</div></li>"""
    jobs = parse_gc_jobs(html)
    assert jobs[0]["company"] == "Example Department"
    assert jobs[0]["date_posted"] is None
    assert jobs[0]["job_url"].endswith("?poster=42")
    assert parse_gc_jobs(html.replace("2099-01-01", "2000-01-01")) == []


def test_vanhack_deduplicates_catalog_and_reads_details():
    def fetcher(url):
        if "/job/" in url:
            return '<h1>Software Engineer</h1><div class="vh-jd-description">Build services</div>'
        return """<a class="vh-card-link" href="/job/42"><h2>Software Engineer</h2>
        <span class="vh-detail-label">Toronto - Canada</span><span class="vh-posted">2 d ago</span></a>"""

    jobs, health = discover_vanhack(
        fetcher=fetcher, catalog_reader=lambda: (fetcher("catalog") * 2, None)
    )
    assert len(jobs) == 1
    assert jobs[0]["description"] == "Build services"
    assert jobs[0]["company"] is None
    assert health[0]["error"] == "posting_date_unknown"


@pytest.mark.parametrize("fault", [None, "incomplete", "rate_limit"])
def test_vanhack_scroll_reader_waits_for_explicit_end_and_closes(monkeypatch, fault):
    from hunter.discovery_browser import read_vanhack_catalog

    context = MagicMock()
    browser = context.__enter__.return_value.chromium.launch.return_value
    page = browser.new_page.return_value
    page.url = "https://app.vanhack.com/jobs"
    page.goto.return_value = Mock(status=429 if fault == "rate_limit" else 200)
    page.content.side_effect = ["first page", "all pages"]
    page.get_by_text.return_value.is_visible.side_effect = [False, True]
    page.locator.return_value.count.return_value = 10
    if fault == "incomplete":
        page.wait_for_function.side_effect = TimeoutError()
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: context)
    html, error = read_vanhack_catalog()
    assert html == (
        "" if fault == "rate_limit" else "first page" if fault == "incomplete" else "all pages"
    )
    assert (
        error
        == {"rate_limit": "http_429", "incomplete": "pagination_incomplete", None: None}[fault]
    )
    browser.close.assert_called_once()
    if fault != "rate_limit":
        page.mouse.wheel.assert_called_once_with(0, 1800)


def test_talentegg_extracts_external_listing_and_ignores_old_roles():
    html = """<div class="display-cell-fill"><div><a class="job-title" href="https://example.com/job/123">IT Support</a></div>
    <div>Example</div><div class="job-metas"><div title="Location">Toronto, Ontario</div>
    <div title="Date Posted">4 days ago</div></div></div>"""
    jobs, health = discover_talentegg({"it_support": ["IT support"]}, fetcher=lambda _: html)
    assert len(jobs) == 1 and jobs[0]["company"] == "Example"
    assert jobs[0]["job_url"] == "https://example.com/job/123"
    assert jobs[0]["date_posted"] is None
    old, _ = discover_talentegg(
        {"it_support": ["IT support"]}, fetcher=lambda _: html.replace("4 days", "30+ days")
    )
    assert old == []


def test_eluta_indexed_time_is_not_posting_date():
    html = """<div class="organic-job" data-url="spl/it-support-123?imo=12">
    <h2>IT Support Analyst</h2><a class="employer">Example</a><span class="location">Montreal QC</span>
    <span class="description">Help with computers</span><a class="lastseen">5 hours ago</a></div>"""
    jobs = parse_eluta_results(html, "it_support")
    assert len(jobs) == 1
    assert jobs[0]["job_url"] == "https://www.eluta.ca/spl/it-support-123"
    assert jobs[0]["date_posted"] is None
    assert jobs[0]["company"] == "Example"
    assert not jobs[0]["auto_apply_eligible"]


def test_wellfound_public_results_are_never_called_complete():
    data = {
        "StartupResult:1": {
            "__typename": "StartupResult",
            "name": "Example",
            "highlightedJobListings": [{"__ref": "JobListingSearchResult:2"}],
        },
        "JobListingSearchResult:2": {
            "id": "2",
            "slug": "it-support",
            "title": "IT Support",
            "liveStartAt": datetime.now(UTC).timestamp(),
            "locationNames": ["Toronto"],
            "description": "Support computers",
        },
    }
    payload = {"props": {"pageProps": {"apolloState": {"data": data}}}}
    html = '<script id="__NEXT_DATA__">' + json.dumps(payload) + "</script>"
    jobs, health = discover_wellfound(fetcher=lambda _: html)
    assert len(jobs) == 1 and jobs[0]["company"] == "Example"
    assert jobs[0]["job_url"] == "https://wellfound.com/jobs/2-it-support"
    assert health[0]["status"] == "partial"
    assert health[0]["error"] == "public_highlights_only"


def test_builtin_details_and_failure_preserve_search_leads():
    today = datetime.now(UTC).date().isoformat()

    def fetcher(url):
        if "/jobs?" in url:
            assert "country=CAN" in url
            return '<h2><a href="/job/it/1">IT Support</a></h2><h2><a href="/job/it/2">IT Technician</a></h2>'
        if url.endswith("/2"):
            raise TimeoutError()
        posting = {
            "@type": "JobPosting",
            "title": "IT Support",
            "datePosted": today,
            "description": "<p>Support computers</p>",
            "hiringOrganization": {"name": "Example"},
            "jobLocation": {"address": {"addressCountry": "CAN", "addressLocality": "Toronto"}},
        }
        return (
            '<script type="application/ld+json">' + json.dumps({"@graph": [posting]}) + "</script>"
        )

    jobs, health = discover_builtin({"it_support": ["IT support"]}, fetcher=fetcher)
    assert len(jobs) == 2
    assert jobs[0]["description"] == "Support computers"
    assert jobs[0]["date_posted"] == today
    assert jobs[0]["location"] == "Toronto, Canada"
    assert jobs[1]["company"] is None
    assert health[0]["error"] == "some_job_details_unavailable"


def test_scrape_saves_completed_batch_before_later_source_fails(monkeypatch):
    from hunter import discovery_browser, discovery_jobright, scraper

    saved = []
    monkeypatch.setattr(scraper, "set_runtime_state", Mock())
    monkeypatch.setattr(scraper, "get_runtime_state", lambda keys: {})
    monkeypatch.setattr(scraper, "init_db", lambda: None)
    monkeypatch.setattr(scraper, "C1Logger", Mock())
    monkeypatch.setattr(scraper, "SEARCH_TERMS", {})
    monkeypatch.setattr(scraper, "add_job", lambda job: (saved.append(job) or "inserted", 1))
    monkeypatch.setattr(scraper, "record_discovery_source_health", Mock())
    for name in (
        "discover_jobillico",
        "discover_builtin",
        "discover_wellfound",
        "discover_talentegg",
        "discover_vanhack",
    ):
        monkeypatch.setattr(scraper, name, lambda *args, **kwargs: ([], []))
    for name in ("discover_gc_jobs", "discover_eluta", "discover_jobs_ca"):
        monkeypatch.setattr(discovery_browser, name, lambda *args, **kwargs: ([], []))
    monkeypatch.setattr(discovery_jobright, "discover_jobright", lambda **kwargs: ([], []))
    monkeypatch.setattr(
        scraper, "discover_public_feeds", lambda **_: ([{"title": "IT support"}], [])
    )

    def fail(**kwargs):
        assert len(saved) == 1
        raise RuntimeError("later source failed")

    monkeypatch.setattr(scraper, "discover_job_bank", lambda *args, **kwargs: fail(**kwargs))
    scraper.scrape(include_public_sources=True, enrich_pending=False)
    assert saved == [{"title": "IT support"}]
    scraper.record_discovery_source_health.assert_called_once_with(
        "job_bank", status="failed", lead_count=0, error="RuntimeError"
    )


def test_jobillico_preserves_first_page_on_failure_and_uses_posted_date():
    today = datetime.now(UTC).date().isoformat()
    urls = []

    def fetcher(url):
        urls.append(url)
        if len(urls) > 1:
            raise TimeoutError()
        return f'''<article><h2><a href="/en/job-offer/example/it/123?tracking=x">IT Customer Support I</a></h2>
        <h3><a>Example</a></h3><ul><li><p>Edmonton - AB</p></li></ul>
        <time datetime="{today}">2 days</time></article>
        <a class="pagination__item__link" href="/search-jobs?skwd=IT&amp;ipg=2">2</a>'''

    jobs, health = discover_jobillico({"it_support": ["IT support"]}, fetcher=fetcher)
    assert len(jobs) == 1
    assert jobs[0]["job_url"] == "https://www.jobillico.com/en/job-offer/example/it/123"
    assert jobs[0]["date_posted"] == today
    assert jobs[0]["discovery_suppressed_reason"] is None
    assert not jobs[0]["auto_apply_eligible"]
    assert health[0]["error"] == "TimeoutError"
    assert health[0]["status"] == "partial"
    assert "ipg=2" in urls[1]


def test_jobs_ca_parser_scopes_results_and_preserves_unknown_posting_dates():
    html = """<section aria-label="Job search results"><article><div>
    <h2><a href="/jobs?q=IT&amp;job=technician">IT Technician</a></h2><p>Example</p>
    </div><ul><li>Toronto, ON</li><li>Added 2 hours ago</li></ul></article></section>
    <article><h2><a href="/unrelated">IT Technician</a></h2></article>"""
    jobs = parse_jobs_ca_results(html, "https://www.itjobs.ca", "it_support", "itjobs_ca")
    assert len(jobs) == 1
    assert jobs[0]["company"] == "Example"
    assert jobs[0]["date_posted"] is None
    assert jobs[0]["enrichment_status"] == "blocked"


def test_jobs_ca_details_use_posting_date_not_added_date():
    job = {
        "title": "IT Technician",
        "company": "Example",
        "category": "it_support",
        "location": "Toronto",
        "job_url": "https://www.itjobs.ca/jobs?job=tech",
        "enrichment_status": "blocked",
        "auto_apply_eligible": False,
    }
    html = """<section aria-label="Job details"><h2>IT Technician</h2>
    <ul><li>Added 1 hour ago</li><li>Posted Sep 24, 2026</li></ul>
    <a aria-label="Open full job posting" href="/example/jobs/tech">Open</a>
    <h3>Job details</h3><p>Support computers and networks.</p></section>"""
    detail = read_jobs_ca_detail(html, job)
    assert detail["date_posted"] == "2026-09-24"
    assert detail["description"] == "Support computers and networks."
    assert detail["job_url"] == "https://www.itjobs.ca/example/jobs/tech"
    assert not detail["auto_apply_eligible"]
    try:
        read_jobs_ca_detail(html.replace("<h2>IT Technician", "<h2>Other role"), job)
    except ValueError:
        pass
    else:
        raise AssertionError("unrelated job detail accepted")


def test_job_bank_retains_it_leads_without_claiming_complete_coverage():
    today = datetime.now(UTC).strftime("%B %d, %Y")
    html = f"""<a class="resultJobItem" href="/jobsearch/jobposting/123;jsessionid=secret?source=search">
      <span class="noctitle">information technology (IT) support technician</span>
      <li class="business">Example</li><li class="location">Location Mississauga (ON)</li>
      <li class="date">{today}</li></a><button id="moreresultbutton">More</button>"""
    jobs, health = discover_job_bank(
        {"it_support": ["IT support", "helpdesk"]}, hours_old=336, fetcher=lambda _: html
    )
    assert len(jobs) == 1
    assert jobs[0]["job_url"] == "https://www.jobbank.gc.ca/jobsearch/jobposting/123"
    assert jobs[0]["category"] == "it_support"
    assert jobs[0]["discovery_suppressed_reason"] is None
    assert not jobs[0]["auto_apply_eligible"]
    assert all(row["status"] == "partial" for row in health)


def test_job_bank_empty_response_is_not_success_and_failures_are_isolated():
    def fetcher(url):
        if "helpdesk" in url:
            raise TimeoutError("private transport detail")
        return "<html>Sign in</html>"

    jobs, health = discover_job_bank(
        {"it_support": ["IT support", "helpdesk"]}, hours_old=336, fetcher=fetcher
    )
    assert jobs == []
    assert [row["status"] for row in health] == ["partial", "failed"]
    assert health[1]["error"] == "TimeoutError"


def test_job_bank_malformed_cards_cannot_report_complete_coverage():
    today = datetime.now(UTC).strftime("%B %d, %Y")
    good = f'<a class="resultJobItem" href="/jobsearch/jobposting/123"><span class="noctitle">IT support technician</span><li class="date">{today}</li></a>'
    for malformed in [
        '<a class="resultJobItem" href="/jobsearch/jobposting/124"></a>',
        '<a class="resultJobItem" href="/jobsearch/jobposting/124"><span class="noctitle"> </span></a>',
        '<a class="resultJobItem" href="/changed-route/124"><span class="noctitle">IT support technician</span></a>',
    ]:
        jobs, health = discover_job_bank(
            {"it_support": ["IT support"]},
            hours_old=336,
            fetcher=lambda url: (
                '<meta property="og:url" content="/jobsearch/jobposting/123"><h1 id="wb-cont">IT support technician</h1><div class="job-posting-detail-requirements">Support users</div>'
                if "/jobposting/" in url
                else good + malformed
            ),
        )
        assert len(jobs) == 1
        assert health[0]["status"] == "partial"
        assert health[0]["error"] == "invalid_listing_card"


def test_job_bank_default_scans_past_four_pages():
    pages = []

    def fetcher(url):
        if "/jobposting/" in url:
            return f'<meta property="og:url" content="{url}"><h1 id="wb-cont">IT support technician</h1><div class="job-posting-detail-requirements">Support users</div>'
        page = int(parse_qs(urlsplit(url).query).get("page", ["1"])[0])
        pages.append(page)
        more = (
            (
                '<button id="moreresultbutton">More</button>'
                '<input id="locationstring-querystring" value="page=1&amp;searchstring=IT">'
            )
            if page < 7
            else ""
        )
        today = datetime.now(UTC).strftime("%B %d, %Y")
        return f'<a class="resultJobItem" href="/jobsearch/jobposting/{page}"><span class="noctitle">IT support technician</span><li class="date">{today}</li></a>{more}'

    jobs, health = discover_job_bank({"it_support": ["IT support"]}, hours_old=336, fetcher=fetcher)
    assert pages == list(range(1, 8))
    assert len(jobs) == 7
    assert health[0]["status"] == "ok"


def test_job_bank_details_validate_identity_expiry_and_preserve_blocked_leads():
    today = datetime.now(UTC).strftime("%B %d, %Y")
    card = f'<a class="resultJobItem" href="/jobsearch/jobposting/123"><span class="noctitle">IT support technician</span><li class="date">{today}</li></a>'
    detail = '<meta property="og:url" content="/jobsearch/jobposting/123"><h1 id="wb-cont">IT support technician</h1><div class="job-posting-brief">Full time</div><div class="job-posting-detail-requirements">Help users resolve network issues</div><div class="hidden">Application submitted</div>'
    for content, status, count in [
        (detail, "ok", 1),
        (detail.replace("/jobposting/123", "/jobposting/999"), "partial", 1),
        (detail.replace("IT support technician", "Another job"), "partial", 1),
        (detail.replace("job-posting-detail-requirements", "unknown"), "partial", 1),
        (detail + '<div id="applynow">Advertised until 2000-01-01</div>', "ok", 0),
        ("<html>Sign in</html>", "partial", 1),
    ]:
        jobs, health = discover_job_bank(
            {"it_support": ["IT support"]},
            hours_old=336,
            fetcher=lambda url: content if "/jobposting/" in url else card,
        )
        assert health[0]["status"] == status and len(jobs) == count
        if jobs:
            assert jobs[0]["enrichment_status"] == "blocked"
            assert not jobs[0]["auto_apply_eligible"]
            if status == "ok":
                assert "Help users" in jobs[0]["description"]
                assert "Application submitted" not in jobs[0]["description"]
            else:
                assert jobs[0]["description"] is None


def test_jobillico_full_scan_and_explicit_test_cap():
    def fetcher(url):
        page = int(parse_qs(urlsplit(url).query).get("page", ["1"])[0])
        more = (
            f'<a class="pagination__item__link" href="/search-jobs?page={page + 1}">{page + 1}</a>'
            if page < 6
            else ""
        )
        return f'<article><h2><a href="/job/{page}">IT support technician</a></h2></article>{more}'

    jobs, health = discover_jobillico({"it_support": ["IT support"]}, fetcher=fetcher)
    assert len(jobs) == 6
    assert health[0]["error"] == "application_links_not_verified"
    jobs, health = discover_jobillico({"it_support": ["IT support"]}, fetcher=fetcher, max_pages=2)
    assert len(jobs) == 2
    assert health[0]["error"] == "page_limit_reached"


def test_workday_pages_and_retains_results_when_one_detail_fails():
    offsets = []

    def poster(url, payload):
        offsets.append(payload["offset"])
        return {
            "total": 21,
            "jobPostings": [
                {"title": "IT Support Technician", "externalPath": f"/job/Canada/IT_R{n}"}
                for n in range(payload["offset"], min(payload["offset"] + 20, 21))
            ],
        }

    def fetcher(url):
        if url.endswith("R1"):
            raise TimeoutError()
        return json.dumps(
            {
                "jobPostingInfo": {
                    "title": "IT Support Technician",
                    "location": "Toronto",
                    "country": {"descriptor": "Canada"},
                    "canApply": True,
                    "externalUrl": "https://example.wd3.myworkdayjobs.com/External"
                    + url.split("/External", 1)[1],
                    "startDate": "2026-10-01",
                    "jobDescription": "Support computers",
                }
            }
        )

    jobs, health = discover_company_career_site(
        "Example",
        "https://example.wd3.myworkdayjobs.com/en-US/External",
        fetcher=fetcher,
        poster=poster,
    )
    assert offsets == [0, 20]
    assert len(jobs) == 21
    missing = next(job for job in jobs if job["job_url"].endswith("R1"))
    assert missing["description"] is None and missing["enrichment_status"] == "blocked"
    assert health["status"] == "partial"
    assert health["error"] == "TimeoutError"
    assert all(not job["auto_apply_eligible"] for job in jobs)


@pytest.mark.parametrize(
    "fault", [None, "changed", "overlap", "excess", "malformed", "negative", "string_total"]
)
def test_workday_catalog_completion_requires_stable_unique_valid_rows(fault):
    from hunter.discovery_sources import discover_workday

    def row(identity):
        return {"title": "IT Support", "externalPath": f"/job/IT_R{identity}"}

    def poster(url, query):
        if query["offset"] == 0:
            return {"total": 3, "jobPostings": [row(1), row(2)]}
        rows = [row(3)]
        total = 3
        if fault == "changed":
            total = 4
        elif fault == "overlap":
            rows = [row(2)]
        elif fault == "excess":
            rows.append(row(4))
        elif fault == "malformed":
            rows[0]["externalPath"] = "/careers"
        elif fault == "negative":
            total = -1
        elif fault == "string_total":
            total = "3"
        return {"total": total, "jobPostings": rows}

    def fetcher(url):
        raise TimeoutError()

    jobs, health = discover_workday(
        "Example",
        {"url": "https://example.wd3.myworkdayjobs.com/wday/cxs/example/External"},
        poster=poster,
        fetcher=fetcher,
    )
    assert len(jobs) == (3 if fault is None else 2)
    assert health["catalog_complete"] == (fault is None)
    assert health["status"] == "partial"
    assert health["error"] == (
        "TimeoutError"
        if fault is None
        else {
            "changed": "catalog_count_changed",
            "overlap": "pagination_repeated",
            "excess": "invalid_workday_page",
            "malformed": "invalid_workday_listing",
            "negative": "invalid_workday_page",
            "string_total": "invalid_workday_page",
        }[fault]
    )


def test_workday_empty_catalog_and_unknown_provider_are_distinct():
    jobs, health = discover_company_career_site(
        "Example",
        "https://example.wd3.myworkdayjobs.com/External",
        poster=lambda *_: {"total": 0, "jobPostings": []},
    )
    assert jobs == [] and health["status"] == "ok"
    jobs, health = discover_company_career_site(
        "Example", "https://example.com/careers", fetcher=lambda _: "<h1>Careers</h1>"
    )
    assert jobs == [] and health["status"] == "pending_manual"


def test_company_landing_page_resolves_published_board_and_rejects_ambiguity():
    from hunter.discovery_sources import resolve_career_fetch_plan

    page = '<iframe src="https://boards.greenhouse.io/embed/job_board?for=example"></iframe>'
    expected = career_fetch_plan("https://job-boards.greenhouse.io/example")
    assert (
        resolve_career_fetch_plan("https://example.com/careers", fetcher=lambda _: page) == expected
    )
    ambiguous = page + '<a href="https://jobs.lever.co/another">Other company</a>'
    plan = resolve_career_fetch_plan("https://example.com/careers", fetcher=lambda _: ambiguous)
    assert plan["method"] == "manual"
    assert plan["error"] == "ambiguous_career_boards"
    assert (
        career_fetch_plan("https://boards.greenhouse.io/embed/job_board?for=../other")["method"]
        == "manual"
    )


def test_company_resolver_follows_published_detail_not_unrelated_hosts():
    from hunter.discovery_sources import resolve_career_fetch_plan

    urls = []

    def fetch(url):
        urls.append(url)
        if url.endswith("/careers"):
            return (
                '<a href="https://unrelated.example/job">Software Engineer</a>'
                '<a href="/careers/job123">Software Developer</a>'
            )
        return '<script src="https://app.greenhouse.io/embed/job_board/js?for=example"></script>'

    plan = resolve_career_fetch_plan("https://example.com/careers", fetcher=fetch)
    assert plan == career_fetch_plan("https://boards.greenhouse.io/example")
    assert urls == ["https://example.com/careers", "https://example.com/careers/job123"]


def test_public_html_legacy_encoding_does_not_drop_source(monkeypatch):
    from email.message import Message

    from hunter import discovery_sources

    response = MagicMock()
    response.__enter__.return_value = response
    response.headers = Message()
    response.headers["Content-Type"] = "text/html; charset=windows-1252"
    response.read.return_value = b"<p>Employ\xe9</p>"
    monkeypatch.setattr(discovery_sources, "urlopen", lambda *args, **kwargs: response)
    assert discovery_sources.fetch_text("https://example.com") == "<p>Employé</p>"


def test_workday_uses_observed_canada_facet_and_skips_old_details():
    queries, details = [], []

    def poster(url, query):
        queries.append(json.loads(json.dumps(query)))
        return {
            "total": 1,
            "jobPostings": [
                {
                    "title": "IT Support",
                    "externalPath": "/job/Canada/Old_R1",
                    "postedOn": "Posted 30+ Days Ago",
                }
            ],
            "facets": [
                {
                    "facetParameter": "Location_Country",
                    "values": [{"descriptor": "Canada", "id": "site-canada-id"}],
                }
            ],
        }

    jobs, health = discover_company_career_site(
        "Example",
        "https://example.wd3.myworkdayjobs.com/External",
        hours_old=336,
        poster=poster,
        fetcher=lambda url: details.append(url),
    )
    assert jobs == [] and details == []
    assert queries[0]["appliedFacets"] == {}
    assert queries[1]["appliedFacets"] == {"Location_Country": ["site-canada-id"]}
    assert health["status"] == "ok"


@pytest.mark.parametrize(
    "fault", [None, "repeat", "missing_detail", "wrong_title", "changed_count"]
)
def test_phenom_catalog_details_and_completion_guards(fault):
    from hunter.discovery_phenom import discover_phenom
    from hunter.discovery_policy import canonical_job_key

    base = "https://careers.example.com/us/en/"
    config = {
        "baseUrl": base,
        "widgetApiEndpoint": "https://careers.example.com/widgets",
        "refNum": "EXAMPLE",
        "locale": "en_us",
        "country": "us",
        "siteType": "external",
        "pageName": "search-results",
    }
    ddo = {
        "eagerLoadRefineSearch": {
            "data": {"aggregations": [{"field": "country", "value": {"CAN": 2, "USA": 5}}]}
        }
    }
    html = (
        "<script>var phApp = phApp || "
        + json.dumps(config)
        + ";phApp.ddo = "
        + json.dumps(ddo)
        + ";</script>"
    )
    rows = [
        {
            "jobId": str(i),
            "jobSeqNo": f"EXAMPLE{i}",
            "title": "IT Support Engineer",
            "country": "CAN",
            "multi_location": ["Richmond Hill, CAN"],
            "postedDate": "2026-10-01T08:00:00Z",
        }
        for i in (1, 2)
    ]
    calls = []

    def poster(url, query):
        calls.append(query)
        if query["ddoKey"] == "refineSearch":
            assert query["sortBy"] == "Most recent"
            assert query["sort"] == {"order": "desc", "field": "postedDate"}
            offset = query["from"]
            row = rows[0] if fault == "repeat" else rows[offset]
            return {
                "refineSearch": {
                    "status": 200,
                    "totalHits": 3 if offset and fault == "changed_count" else 2,
                    "data": {"jobs": [row]},
                }
            }
        if query["jobSeqNo"] == "EXAMPLE2" and fault == "missing_detail":
            raise TimeoutError()
        row = next(r for r in rows if r["jobSeqNo"] == query["jobSeqNo"])
        detail = {
            **row,
            "multi_location": [{"cityStateCountry": "Richmond Hill, Canada"}],
            "description": "<p>Maintain computers and networks.</p>",
            "jobVisibility": ["external"],
        }
        if fault == "wrong_title":
            detail["title"] = "Different role"
        return {"jobDetail": {"status": 200, "data": {"job": detail}}}

    jobs, health = discover_phenom(
        "Example",
        {"method": "phenom", "url": base + "search-results"},
        fetcher=lambda _: html,
        poster=poster,
    )
    assert all(
        q["selected_fields"] == {"country": ["CAN"]} for q in calls if q["ddoKey"] == "refineSearch"
    )
    assert health["status"] == ("partial" if fault else "ok")
    if fault is None:
        assert len(jobs) == 2 and all(
            j["description"] == "Maintain computers and networks." for j in jobs
        )
        assert all(
            j["location"] == "Richmond Hill, Canada" and not j["auto_apply_eligible"] for j in jobs
        )
        assert canonical_job_key(jobs[0]["job_url"], "Example") == canonical_job_key(
            base + "job/1/IT-Support-Engineer", "Example"
        )
    if fault == "missing_detail":
        assert len(jobs) == 2 and not jobs[1].get("description")
    bad = html.replace("https://careers.example.com/widgets", "https://attacker.test/widgets")
    assert (
        discover_phenom(
            "Example", {"method": "phenom", "url": base}, fetcher=lambda _: bad, poster=poster
        )[1]["status"]
        == "failed"
    )


def test_ibm_search_paginates_and_never_treats_teasers_as_full_descriptions():
    from hunter.discovery_ibm import discover_ibm

    calls = []

    def poster(url, query):
        calls.append(query)
        start = query["from"]
        return {
            "hits": {
                "total": {"value": 32, "relation": "eq"},
                "hits": [
                    {
                        "_source": {
                            "title": "IT Support Engineer",
                            "url": f"https://careers.ibm.com/careers/JobDetail?jobId={i}",
                            "field_keyword_19": "Markham, CA",
                            "description": "Short teaser...",
                        }
                    }
                    for i in range(start, min(start + 30, 32))
                ],
            }
        }

    jobs, health = discover_ibm(
        "IBM",
        {"method": "ibm", "url": "https://www.ibm.com/careers/search"},
        poster=poster,
        detail_reader=lambda jobs: None,
    )
    assert [q["from"] for q in calls] == [0, 30]
    assert all(q["sort"] == [{"title.keyword": "asc"}, {"dcdate": "desc"}] for q in calls)
    assert all(q["post_filter"] == {"term": {"field_keyword_05": "Canada"}} for q in calls)
    assert len(jobs) == 32 and all(not j.get("description") for j in jobs)
    assert all(not j["auto_apply_eligible"] for j in jobs)
    assert health["status"] == "partial" and health["error"] == "description_not_found"

    assert health["catalog_complete"] is True


@pytest.mark.parametrize("failure", ["repeat", "empty", "timeout", "lower_bound", "count_changed"])
def test_ibm_search_keeps_first_page_when_catalog_completion_fails(failure):
    from hunter.discovery_ibm import discover_ibm

    row = {
        "_source": {
            "title": "IT Support Engineer",
            "url": "https://careers.ibm.com/careers/JobDetail?jobId=1",
        }
    }

    def poster(url, query):
        if query["from"]:
            if failure == "timeout":
                raise TimeoutError()
            return {
                "hits": {
                    "total": {
                        "value": 3 if failure == "count_changed" else 2,
                        "relation": "gte" if failure == "lower_bound" else "eq",
                    },
                    "hits": [] if failure == "empty" else [row],
                }
            }
        return {"hits": {"total": {"value": 2, "relation": "eq"}, "hits": [row]}}

    def detail(jobs):
        for job in jobs:
            job["description"] = "Full description"

    jobs, health = discover_ibm(
        "IBM",
        {"method": "ibm", "url": "https://www.ibm.com/careers/search"},
        poster=poster,
        detail_reader=detail,
    )
    assert len(jobs) == 1 and health["status"] == "partial"
    if failure == "count_changed":
        assert health["error"] == "catalog_changed_during_scan"

    assert health["catalog_complete"] is False


def test_ibm_details_require_matching_canonical_id_title_and_visible_job_id():
    from hunter.discovery_ibm import parse_ibm_detail
    from hunter.discovery_policy import canonical_job_key

    job = {
        "title": "IT Support Engineer",
        "job_url": "https://careers.ibm.com/careers/JobDetail?jobId=123",
    }
    html = """<link rel="canonical" href="https://careers.ibm.com/en_US/careers/JobDetail/IT-Support-Engineer/123">
        <h2 class="banner__text__title">IT Support Engineer</h2><main>
        <article class="article--sidebar"><div>Job ID</div><div>123</div><div>Country</div><div>Canada</div></article>
        <article class="article--details">Support computers and networks.</article></main>"""
    result = parse_ibm_detail(html, job)
    assert canonical_job_key(job["job_url"], "IBM") == canonical_job_key(
        "https://careers.ibm.com/en_US/careers/JobDetail/IT-Support-Engineer/123", "IBM Canada"
    )
    assert result == {"description": "Support computers and networks.", "location": "Canada"}
    for wrong in (
        html.replace("/123", "/124"),
        html.replace("<div>123", "<div>124"),
        html.replace("IT Support Engineer</h2>", "Other role</h2>"),
    ):
        with pytest.raises(ValueError, match="detail_identity_mismatch"):
            parse_ibm_detail(wrong, job)


def test_ibm_browser_retries_only_timeout_and_closes_owned_browser(monkeypatch):
    import playwright.sync_api

    from hunter import discovery_ibm

    runtime = MagicMock()
    browser = runtime.__enter__.return_value.chromium.launch.return_value
    page = browser.new_page.return_value
    page.url = "https://careers.ibm.com/en_US/careers/JobDetail?jobId=1"
    page.goto.side_effect = [
        playwright.sync_api.TimeoutError("slow page"),
        Mock(status=200),
        Mock(status=403),
    ]
    monkeypatch.setattr(playwright.sync_api, "sync_playwright", lambda: runtime)
    monkeypatch.setattr(
        discovery_ibm, "parse_ibm_detail", lambda html, job: {"description": "Verified detail"}
    )
    jobs = [
        {"job_url": "https://careers.ibm.com/careers/JobDetail?jobId=1"},
        {"job_url": "https://careers.ibm.com/careers/JobDetail?jobId=2"},
    ]
    assert discovery_ibm.read_ibm_details(jobs) == "http_403"
    assert jobs[0]["description"] == "Verified detail" and "description" not in jobs[1]
    assert page.goto.call_count == 3
    browser.close.assert_called_once()


def test_workday_nested_location_filters_preserve_possible_remote_canada():
    values = [
        {"id": "ottawa", "descriptor": "Ottawa, Ontario, Canada"},
        {"id": "remote", "descriptor": "Remote"},
        {"id": "us", "descriptor": "Austin, Texas, United States"},
    ]
    calls = []

    def poster(url, query):
        calls.append(query.copy())
        return {
            "jobPostings": [],
            "total": 0,
            "facets": [
                {
                    "facetParameter": "locationMainGroup",
                    "values": [{"facetParameter": "locations", "values": values}],
                }
            ],
        }

    _, health = discover_company_career_site(
        "Example", "https://example.wd1.myworkdayjobs.com/Careers", poster=poster
    )
    assert health["status"] == "ok"
    assert calls[-1]["appliedFacets"] == {"locations": ["ottawa", "remote"]}
    values[:] = [{"id": "us", "descriptor": "Austin, Texas, United States"}]
    calls.clear()
    discover_company_career_site(
        "Example", "https://example.wd1.myworkdayjobs.com/Careers", poster=poster
    )
    assert len(calls) == 1 and calls[0]["appliedFacets"] == {}


def test_workday_repeated_page_is_partial_even_without_matching_leads():
    jobs, health = discover_company_career_site(
        "Example",
        "https://example.wd3.myworkdayjobs.com/External",
        poster=lambda *_: {
            "total": 40,
            "jobPostings": [{"title": "Cashier", "externalPath": "/job/Cashier_R1"}],
        },
    )
    assert jobs == []
    assert health["status"] == "partial"
    assert health["error"] == "pagination_repeated"


def test_workday_scans_beyond_one_thousand_and_respects_actual_page_size():
    offsets = []

    def poster(url, query):
        offset = query["offset"]
        offsets.append(offset)
        return {
            "total": 1003,
            "jobPostings": [
                {"title": "Cashier", "externalPath": f"/job/Cashier_R{i}"}
                for i in range(offset, min(offset + 7, 1003))
            ],
        }

    jobs, health = discover_company_career_site(
        "Example", "https://example.wd3.myworkdayjobs.com/External", poster=poster
    )
    assert jobs == []
    assert health["status"] == "ok"
    assert offsets == list(range(0, 1003, 7))


def test_jobright_preserves_easy_apply_exclusion_and_does_not_invent_description():
    jobs, ids = parse_jobright_page(
        {
            "success": True,
            "result": {
                "jobList": [
                    {
                        "companyResult": {"companyName": "Example"},
                        "jobResult": {
                            "jobId": "abc",
                            "jobTitle": "IT Support Technician",
                            "jobLocation": "Toronto, Canada",
                            "jobtargetEasyapply": True,
                            "publishTime": datetime.now(UTC).isoformat(),
                            "jobSummary": "AI summary, not the original description",
                        },
                    }
                ]
            },
        }
    )
    assert ids == ["abc"]
    assert jobs[0]["apply_type"] == "easy_apply"
    assert jobs[0]["description"] is None
    assert jobs[0]["apply_url"] is None
    assert not jobs[0]["auto_apply_eligible"]
    assert jobs[0]["discovery_suppressed_reason"] == "easy_apply_ineligible"


def test_jobright_invalid_response_is_not_empty_success():
    for payload in ({}, {"success": False}, {"success": True, "result": {}}):
        with pytest.raises(ValueError):
            parse_jobright_page(payload)
    assert parse_jobright_page({"success": True, "result": {"jobList": []}}) == ([], [])
    with pytest.raises(ValueError, match="jobright_hourly_refresh_limit"):
        parse_jobright_page({"success": False, "errorCode": 43004})


@pytest.mark.parametrize("failure", ["network", "other", "foreign", "repeated", "telemetry"])
def test_jobright_initial_network_retry_is_bounded_and_transport_only(failure):
    from playwright.sync_api import Error

    from hunter.discovery_jobright import _load_recommendations

    page = MagicMock()

    def navigate(*args, **kwargs):
        callback = page.on.call_args.args[1]
        callback(
            Mock(
                url="https://evil.test/code.js"
                if failure == "foreign"
                else "https://static.jobright.ai/code.js",
                failure="net::ERR_NETWORK_CHANGED" if failure != "other" else "net::ERR_FAILED",
                resource_type="fetch" if failure == "telemetry" else "script",
            )
        )
        raise Error("Initial resource load failed")

    page.goto.side_effect = navigate
    if failure == "repeated":
        page.reload.side_effect = Error("Still interrupted")
    if failure == "network":
        assert _load_recommendations(page) is not None
    else:
        with pytest.raises(Error):
            _load_recommendations(page)
    assert page.reload.call_count == (1 if failure in {"network", "repeated"} else 0)
    page.goto.assert_called_once()
    page.remove_listener.assert_called_once()


@pytest.mark.parametrize("suffix", ["", "?page=0"])
def test_jobright_response_match_does_not_require_query_parameters(suffix):
    from hunter.discovery_jobright import _recommendation_response

    assert _recommendation_response(
        Mock(url="https://jobright.ai/swan/recommend/list/jobs" + suffix)
    )
    assert not _recommendation_response(
        Mock(url="https://evil.test/swan/recommend/list/jobs" + suffix)
    )
    assert not _recommendation_response(
        Mock(url="https://jobright.ai/swan/recommend/list/jobs/other")
    )


def test_jobright_disconnected_cleanup_preserves_crash_diagnostic(monkeypatch, tmp_path):
    import playwright.sync_api

    from hunter import discovery_jobright as module

    monkeypatch.setattr(playwright.sync_api, "sync_playwright", MagicMock())
    context = MagicMock()
    page = context.__enter__.return_value.new_page.return_value
    page.get_by_text.return_value.count.side_effect = playwright.sync_api.Error("Page crashed")
    page.close.side_effect = playwright.sync_api.Error("Disconnected")
    monkeypatch.setattr(module, "_jobright_context", lambda *args: context)
    monkeypatch.setattr(
        module, "_load_recommendations", Mock(side_effect=playwright.sync_api.Error("Page crashed"))
    )
    session = tmp_path / "session.json"
    session.write_text("{}")
    monkeypatch.delenv("HUNT_JOBRIGHT_CDP_URL", raising=False)
    jobs, health = module.discover_jobright(storage_state=session)
    assert jobs == []
    assert health[0]["status"] == "failed"
    assert health[0]["error"] == "jobright_browser_crashed"
    page.close.assert_called_once()


def test_jobright_uses_valid_apply_link_when_original_url_is_invalid():
    jobs, _ = parse_jobright_page(
        {
            "success": True,
            "result": {
                "jobList": [
                    {
                        "jobResult": {
                            "jobId": "fallback",
                            "jobTitle": "IT Support",
                            "jobLocation": "Canada",
                            "originalUrl": "javascript:void(0)",
                            "applyLink": "https://example.com/jobs/123",
                        }
                    }
                ]
            },
        }
    )
    assert jobs[0]["apply_url"] == "https://example.com/jobs/123"


def test_jobright_without_browser_reports_required_setup(monkeypatch):
    monkeypatch.delenv("HUNT_JOBRIGHT_CDP_URL", raising=False)
    saved = []
    jobs, health = discover_jobright(on_result=lambda jobs, health: saved.extend(health))
    assert not jobs
    assert health[0]["status"] == "needs_login"
    assert saved == health


def test_public_fetch_retries_transient_errors_but_not_access_denials(monkeypatch):
    from hunter import discovery_sources as sources

    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    response.read.return_value = b"ok"
    response.headers.get_content_charset.return_value = None
    opener = Mock(
        side_effect=[HTTPError("https://example.com", 502, "bad gateway", {}, None), response]
    )
    sleep = Mock()
    monkeypatch.setattr(sources, "urlopen", opener)
    monkeypatch.setattr(sources.time, "sleep", sleep)
    assert sources.fetch_text("https://example.com") == "ok"
    assert opener.call_count == 2
    sleep.assert_called_once_with(2)
    for code, headers in ((403, {}), (429, {"Retry-After": "120"})):
        opener.reset_mock(side_effect=True)
        opener.side_effect = HTTPError("https://example.com", code, "blocked", headers, None)
        with pytest.raises(HTTPError):
            sources.fetch_text("https://example.com")
        assert opener.call_count == 1


def test_jobright_session_export_is_scoped_and_preserves_prior_file_on_failure(
    monkeypatch, tmp_path
):
    import playwright.sync_api

    from hunter import discovery_jobright as module

    runtime = MagicMock()
    browser = runtime.__enter__.return_value.chromium.connect_over_cdp.return_value
    browser.contexts = [Mock()]
    browser.contexts[0].storage_state.return_value = {
        "cookies": [
            {"domain": ".jobright.ai", "value": "jobright-only"},
            {"domain": ".google.com", "value": "do-not-export"},
        ],
        "origins": [
            {"origin": "https://jobright.ai", "localStorage": []},
            {"origin": "https://accounts.google.com", "localStorage": []},
        ],
    }
    monkeypatch.setattr(playwright.sync_api, "sync_playwright", lambda: runtime)
    path = tmp_path / "session.json"
    save_jobright_session("http://127.0.0.1:9223", path)
    original = path.read_bytes()
    assert b"do-not-export" not in original
    assert b"google.com" not in original
    browser.close.assert_not_called()
    monkeypatch.setattr(module.json, "dump", Mock(side_effect=OSError("disk full")))
    with pytest.raises(OSError):
        save_jobright_session("http://127.0.0.1:9223", path)
    assert path.read_bytes() == original
    assert list(tmp_path.iterdir()) == [path]


def test_public_source_failure_does_not_skip_other_sources_but_db_failure_stops(monkeypatch):
    from hunter import discovery_browser, discovery_jobright, scraper

    monkeypatch.setattr(scraper, "get_runtime_state", lambda keys: {})
    monkeypatch.setattr(scraper, "set_runtime_state", Mock())

    for name in (
        "discover_public_feeds",
        "discover_job_bank",
        "discover_jobillico",
        "discover_builtin",
        "discover_wellfound",
        "discover_talentegg",
        "discover_vanhack",
    ):
        monkeypatch.setattr(scraper, name, lambda *args, **kwargs: ([], []))
    for name in ("discover_gc_jobs", "discover_eluta", "discover_jobs_ca"):
        monkeypatch.setattr(discovery_browser, name, lambda *args, **kwargs: ([], []))
    monkeypatch.setattr(discovery_jobright, "discover_jobright", lambda **kwargs: ([], []))
    broken = Mock(side_effect=TimeoutError("private transport details"))
    later = Mock(
        side_effect=lambda *args, **kwargs: kwargs["on_result"]([{"title": "IT Support"}], [])
    )
    monkeypatch.setattr(scraper, "discover_job_bank", broken)
    monkeypatch.setattr(scraper, "discover_jobillico", later)
    saved = []
    scraper._discover_public_sources(336, lambda jobs, health: saved.append((jobs, health)))
    later.assert_called_once()
    assert any(health and health[0]["error"] == "TimeoutError" for _, health in saved)
    assert any(jobs == [{"title": "IT Support"}] for jobs, _ in saved)

    def swallowed_callback_failure(**kwargs):
        try:
            kwargs["on_result"]([{"title": "IT Support"}], [])
        except OSError:
            pass
        return [], []

    monkeypatch.setattr(discovery_jobright, "discover_jobright", swallowed_callback_failure)
    with pytest.raises(OSError, match="database unavailable"):
        scraper._discover_public_sources(336, Mock(side_effect=OSError("database unavailable")))
    deferred = Mock()
    monkeypatch.setattr(discovery_jobright, "discover_jobright", deferred)
    monkeypatch.setattr(
        scraper,
        "get_runtime_state",
        lambda keys: {
            "jobright_retry_after": {"value": (datetime.now(UTC) + timedelta(hours=1)).isoformat()}
        },
    )
    health_updates = []
    scraper._discover_public_sources(336, lambda jobs, health: health_updates.extend(health))
    deferred.assert_not_called()
    assert health_updates[0]["status"] == "rate_limited"
    assert health_updates[0]["error"].startswith("jobright_cooldown_until_")


def test_ashby_keeps_canadian_secondary_locations_and_excludes_unlisted():
    from hunter.discovery_sources import discover_company_career_site

    row = {
        "title": "IT Support",
        "location": "United States",
        "jobUrl": "https://jobs.ashbyhq.com/example/123456",
        "secondaryLocations": [
            {"location": "Remote North", "address": {"postalAddress": {"addressCountry": "CA"}}}
        ],
    }
    jobs, health = discover_company_career_site(
        "Example",
        "https://jobs.ashbyhq.com/example",
        fetcher=lambda _: json.dumps(
            {"jobs": [row, {**row, "jobUrl": row["jobUrl"] + "7", "isListed": False}]}
        ),
    )
    assert health["status"] == "ok"
    assert len(jobs) == 1
    assert jobs[0]["location"] == "United States; Remote North, Canada"
    assert jobs[0]["discovery_suppressed_reason"] != "outside_canada"


def test_successfactors_follows_real_forward_links_and_preserves_failed_details():
    from hunter.discovery_sources import discover_company_career_site

    root = "https://careers.example.com/"
    search = root + "search/"

    def page(job, next_link=""):
        return f'<div id="searchresults"><table><tr class="data-row"><td><a class="jobTitle-link" href="/job/{job}">IT Support</a><span class="jobLocation">Toronto, ON, CA</span><span class="jobDate">Oct 1, 2026</span></td></tr></table>{next_link}</div>'

    responses = {
        root: '<footer>SuccessFactors</footer><form action="/search/"><input name="q"></form>',
        search: page("1", '<a href="?startrow=25">2</a><a href="?startrow=50">Last</a>'),
        search + "?startrow=25": page("2"),
        root + "job/1": '<div itemprop="description">Provide network and computer support.</div>',
    }
    calls = []

    def fetch(url):
        calls.append(url)
        if url.endswith("job/2"):
            raise TimeoutError()
        return responses[url]

    jobs, health = discover_company_career_site("Example", root, fetcher=fetch)
    assert len(jobs) == 2
    assert health["status"] == "partial" and health["error"] == "TimeoutError"
    assert jobs[0]["description"] == "Provide network and computer support."
    assert jobs[0]["date_posted"] == "2026-10-01"
    assert not jobs[0]["auto_apply_eligible"]
    assert search + "?startrow=50" not in calls
    responses[search + "?startrow=25"] = page("1", '<a href="?startrow=50">3</a>')
    jobs, health = discover_company_career_site("Example", root, fetcher=fetch)
    assert len(jobs) == 1 and health["error"] == "repeated_page"
    responses[search] = "<html>Sign in</html>"
    jobs, health = discover_company_career_site("Example", root, fetcher=fetch)
    assert jobs == [] and health["status"] == "failed"


@pytest.mark.parametrize("label", ["Open positions", "Search Careers Icon", "Find a job"])
def test_employer_resolver_follows_published_open_positions_navigation(label):
    from hunter.discovery_sources import resolve_career_fetch_plan

    root = "https://example.com/careers"
    pages = {
        root: f'<a href="/company/jobs">{label}</a>',
        "https://example.com/company/jobs": '<iframe src="https://boards.greenhouse.io/example"></iframe>',
    }
    plan = resolve_career_fetch_plan(root, fetcher=pages.__getitem__)
    assert plan["method"] == "greenhouse"
    assert "/example/jobs" in plan["url"]


def test_employer_resolver_reads_embedded_links_without_executing_code():
    from hunter.discovery_sources import resolve_career_fetch_plan

    root = "https://example.com/careers"
    pages = [
        r'<div x-data="[{&quot;url&quot;:&quot;https:\/\/jobs.ashbyhq.com\/example\/123&quot;}]"></div>',
        '<script>window.jobs = [{"url":"https://jobs.ashbyhq.com/example/123"}]</script>',
        "<a :href=\"job.url || 'https://jobs.ashbyhq.com/example'\">Apply</a>",
    ]
    for page in pages:
        plan = resolve_career_fetch_plan(root, fetcher=lambda _: page)
        assert plan == career_fetch_plan("https://jobs.ashbyhq.com/example")
    ambiguous = pages[1] + '<a href="https://jobs.lever.co/other">Jobs</a>'
    plan = resolve_career_fetch_plan(root, fetcher=lambda _: ambiguous)
    assert plan["error"] == "ambiguous_career_boards"
    spoof = '<script>"https://jobs.ashbyhq.com.evil.test/example"</script>'
    assert resolve_career_fetch_plan(root, fetcher=lambda _: spoof)["method"] == "manual"


@pytest.mark.parametrize(
    "fault",
    [
        None,
        "repeat",
        "missing_page",
        "foreign_page",
        "wrong_title",
        "missing_detail",
        "missing_identity",
        "missing_visibility",
        "changed_count",
    ],
)
def test_paradox_public_catalog_and_detail_guards(fault):
    from hunter.discovery_paradox import discover_paradox
    from hunter.discovery_sources import resolve_career_fetch_plan

    base = "https://careers.example.com"
    rows = [
        dict(
            uniqueID=str(i),
            requisitionID=f"R{i}",
            title="IT Support Analyst",
            isInternal="false",
            originalURL=f"support/job/{i}",
            locations=[dict(city="Toronto", state="Ontario", country="Canada")],
        )
        for i in (1, 2)
    ]
    if fault == "missing_identity":
        for row in rows:
            row["requisitionID"] = None
    if fault == "missing_visibility":
        rows[1].pop("isInternal")

    def page(row, total=2, next_page=None):
        return (
            '<script src="https://cdn.sites.paradox.ai/main.js"></script>'
            "<script>window.__PRELOAD_STATE__ = "
            + json.dumps({"jobSearch": {"jobs": [row], "totalJob": total}})
            + ";</script>"
            + (f'<a href="{next_page}" aria-label="Go to next page">Next</a>' if next_page else "")
        )

    def fetcher(url):
        if url == base + "/jobs":
            return page(
                rows[0],
                next_page=None
                if fault == "missing_page"
                else "https://other.test/jobs/page/2"
                if fault == "foreign_page"
                else "/jobs/page/2",
            )
        if url == base + "/jobs/page/2":
            return page(
                rows[0] if fault == "repeat" else rows[1],
                total=3 if fault == "changed_count" else 2,
            )
        row = rows[int(url.rsplit("/", 1)[-1]) - 1]
        if fault == "missing_detail":
            raise TimeoutError()
        return (
            '<script type="application/ld+json">'
            + json.dumps(
                {
                    "@type": "JobPosting",
                    "url": url,
                    "title": "Wrong title" if fault == "wrong_title" else row["title"],
                    "identifier": {"value": row["requisitionID"]},
                    "description": "<p>Support computers.</p>",
                    "datePosted": "2026-10-01T00:00:00Z",
                }
            )
            + "</script>"
        )

    plan = resolve_career_fetch_plan(base + "/jobs", fetcher=fetcher)
    assert plan["method"] == "paradox"
    jobs, health = discover_paradox("Example", plan, fetcher=fetcher)
    assert health["status"] == ("partial" if fault else "ok")
    assert all(not row["auto_apply_eligible"] for row in jobs)
    if fault is None:
        assert len(jobs) == 2 and all(row["description"] == "Support computers." for row in jobs)
        assert jobs[0]["date_posted"] == "2026-10-01"
    if fault in {"wrong_title", "missing_detail", "missing_identity"}:
        assert len(jobs) == 2 and all(not row["description"] for row in jobs)


@pytest.mark.parametrize(
    "fault",
    [None, "repeat", "changed_count", "wrong_id", "timeout", "missing_next", "foreign_next"],
)
def test_avature_catalog_counts_details_and_pagination(fault):
    from hunter.discovery_avature import discover_avature
    from hunter.discovery_sources import resolve_career_fetch_plan

    base = "https://jobs.example.com/en_CA/careers/searchjobs"

    def fetcher(url):
        if "JobDetail" in url:
            if fault == "timeout":
                raise TimeoutError()
            identity = "wrong" if fault == "wrong_id" else url.rsplit("/", 1)[-1]
            return (
                '<main><h2 class="title--11">IT Support Analyst</h2>'
                f'<div class="article__content__view__field"><div class="article__content__view__field__label">Job number</div><div class="article__content__view__field__value">{identity}</div></div>'
                '<div class="article__content__view__field"><div class="article__content__view__field__label">Posting date</div><div class="article__content__view__field__value">01-Oct-2026</div></div>'
                '<article class="table-fields-label--hidden">Support computers.</article>'
                '<article class="article--details">Health benefits.</article>'
                '<div class="article__content__view__field"><div class="article__content__view__field__value"><strong>Location(s):</strong>Toronto, Ottawa</div></div>'
                '<iframe src="https://maps.google.com/maps?q=Canada,Ontario,Toronto"></iframe></main>'
            )
        second = "jobOffset" in url
        identity = 1 if not second or fault == "repeat" else 2
        total = 3 if second and fault == "changed_count" else 2
        next_url = (
            "https://other.test/en_CA/careers/searchjobs?jobOffset=1"
            if fault == "foreign_next"
            else base + "?jobOffset=1"
        )
        return (
            '<script src="https://templates-static-assets.avacdn.net/core.js"></script>'
            f'<div class="list-controls__text">{identity}-{identity} of {total} result(s)</div>'
            f'<table><tr><th><a data-map="job-detail-link" href="https://jobs.example.com/en_CA/careers/JobDetail/support/{identity}">IT Support Analyst</a></th><td>2 possible locations</td></tr></table>'
            + (
                f'<a class="paginationNextLink" href="{next_url}">Next</a>'
                if not second and fault != "missing_next"
                else ""
            )
        )

    plan = resolve_career_fetch_plan(base, fetcher=fetcher)
    assert plan["method"] == "avature"
    jobs, health = discover_avature("Example", plan, fetcher=fetcher)
    assert health["status"] == ("partial" if fault else "ok")
    assert all(not row["auto_apply_eligible"] for row in jobs)
    if fault is None:
        assert len(jobs) == 2
        assert all(row["description"] == "Support computers.\nHealth benefits." for row in jobs)
        assert all(
            row["location"] == "Toronto, Ottawa; Canada,Ontario,Toronto"
            and row["date_posted"] == "2026-10-01"
            for row in jobs
        )
    if fault in {"wrong_id", "timeout"}:
        assert len(jobs) == 2 and all(not row["description"] for row in jobs)


@pytest.mark.parametrize(
    "fault", [None, "repeat", "empty", "overcount", "config", "foreign", "ended"]
)
def test_successfactors_tile_pages_follow_published_counts(fault):
    from hunter.discovery_sources import discover_successfactors

    root = "https://jobs.example.com/brand/search/"
    calls = []

    def tile(identity):
        target = f"/brand/job/it-support/{identity}/"
        if fault == "foreign":
            target = "https://other.example/job/1"
        return f'''<li class="job-tile"><a class="jobTitle-link" href="{target}">IT Support Analyst</a>
        <div class="section-field date"><div id="date-value">Oct 1, 2026</div></div></li>'''

    def fetch(url):
        calls.append(url)
        if "/job/" in url:
            if fault == "ended" and url.endswith("/3/"):
                return "<strong>Sorry, this job posting has ended.</strong>"
            return '<div itemprop="description">Support computers.</div>'
        if url == root:
            config = (
                ""
                if fault == "config"
                else """<script>j2w.SearchResults.init({
                apiEndpoint: "tile-search-results", searchQuery: "?q=IT&sortDirection=desc",
                jobRecordsFound: parseInt("3")});</script>"""
            )
            return '<ul id="job-tile-list">' + tile(1) + tile(2) + "</ul>" + config
        assert (
            url
            == "https://jobs.example.com/brand/tile-search-results/?q=IT&sortDirection=desc&startrow=2"
        )
        if fault == "empty":
            return ""
        return tile(1 if fault == "repeat" else 3) + (tile(4) if fault == "overcount" else "")

    jobs, health = discover_successfactors(
        "Example", {"method": "successfactors", "url": root}, fetcher=fetch
    )
    if fault in {None, "ended"}:
        assert health["status"] == "ok" and len(jobs) == (2 if fault == "ended" else 3)
        assert all(
            j["description"] == "Support computers." and j["date_posted"] == "2026-10-01"
            for j in jobs
        )
        assert all(not j["auto_apply_eligible"] for j in jobs)
    else:
        assert health["status"] != "ok" and health["error"]
        if fault in {"repeat", "empty"}:
            assert len(jobs) == 2
        assert not any("other.example" in url for url in calls)


def test_smartrecruiters_paginates_and_keeps_leads_after_detail_failure():
    root = "https://jobs.smartrecruiters.com/Example"
    api = career_fetch_plan(root)["url"]
    calls = []

    def fetch(url):
        calls.append(url)
        if "?" in url:
            offset = int(parse_qs(urlsplit(url).query)["offset"][0])
            ids = range(1, 101) if offset == 0 else [101, 102]
            return json.dumps(
                {
                    "offset": offset,
                    "totalFound": 102,
                    "content": [
                        {
                            "id": str(i),
                            "name": "IT Support Analyst",
                            "location": {"city": "Toronto", "country": "ca"},
                            "releasedDate": "2026-10-01T12:00:00Z",
                        }
                        for i in ids
                    ],
                }
            )
        identity = url.rsplit("/", 1)[-1]
        if identity == "101":
            raise HTTPError(url, 503, "busy", None, None)
        return json.dumps(
            {
                "id": identity,
                "name": "IT Support Analyst",
                "active": identity != "102",
                "visibility": "PUBLIC",
                "postingUrl": root + "/" + identity + "-it-support",
                "jobAd": {
                    "sections": {
                        "jobDescription": {"text": "<p>Support users.</p>"},
                        "qualifications": {"text": "<p>Networking skills.</p>"},
                    }
                },
            }
        )

    jobs, health = discover_company_career_site("Example", root, fetcher=fetch)
    assert len(jobs) == 101
    assert health["status"] == "partial" and health["error"] == "http_503"
    assert api + "?limit=100&offset=100" in calls
    assert "Networking skills." in jobs[0]["description"]
    assert jobs[-1]["description"] is None
    assert all(not j["auto_apply_eligible"] for j in jobs)


@pytest.mark.parametrize("ending", ["complete", "missing_token", "repeat"])
def test_workable_directory_follows_tokens_and_reports_partial_catalog(ending):
    root = "https://apply.workable.com/example/"
    row = {
        "shortcode": "ABC",
        "title": "IT Support Analyst",
        "state": "published",
        "isInternal": False,
        "locations": [{"country": "Canada"}],
    }
    calls = []

    def post(url, payload):
        calls.append(payload)
        if not payload:
            return {"total": 2, "results": [row], "nextPage": "opaque-next"}
        assert payload == {"token": "opaque-next"}
        if ending == "repeat":
            return {"total": 2, "results": [row], "nextPage": "opaque-next"}
        return {
            "total": 3 if ending == "missing_token" else 2,
            "results": [{**row, "shortcode": "DEF"}],
        }

    def fetch(url):
        code = url.rsplit("/", 1)[-1]
        if code == "DEF":
            raise HTTPError(url, 503, "busy", None, None)
        return json.dumps(
            {
                **row,
                "description": "Support users.",
                "requirements": "Networking.",
                "benefits": "Training.",
            }
        )

    jobs, health = discover_company_career_site("Example", root, fetcher=fetch, poster=post)
    assert len(calls) == 2
    assert "Networking." in jobs[0]["description"] and "Training." in jobs[0]["description"]
    assert health["status"] == "partial"
    assert (
        health["error"]
        == {
            "complete": "http_503",
            "missing_token": "pagination_incomplete",
            "repeat": "repeated_page",
        }[ending]
    )
    assert not jobs[0]["auto_apply_eligible"]


def test_teamtailor_follows_show_more_and_retains_failed_details():
    root = "https://example.com/jobs"
    marker = '<script src="https://assets.teamtailor-cdn.com/careersite.js"></script><a href="/jobs">Jobs</a>'
    card = '<a href="/jobs/{id}-support"><span title="Support TI">Truncated</span></a>'
    pages = {
        root: marker + card.format(id=123) + '<a href="/jobs/show_more?page=2">Show more</a>',
        "https://example.com/jobs/show_more?page=2": card.format(id=456),
        "https://example.com/jobs/123-support": '<script type="application/ld+json">'
        + json.dumps(
            {
                "@type": "JobPosting",
                "identifier": {"value": "123"},
                "title": "Support TI",
                "description": "&lt;p&gt;Support computers.&lt;/p&gt;",
                "datePosted": "2026-10-01",
                "jobLocation": [
                    {"address": {"addressLocality": "Montréal", "addressCountry": "CA"}}
                ],
            }
        )
        + "</script>",
    }

    def fetch(url):
        if url not in pages:
            raise HTTPError(url, 503, "busy", None, None)
        return pages[url]

    jobs, health = discover_company_career_site("Example", root, fetcher=fetch)
    assert len(jobs) == 2 and health["status"] == "partial"
    assert health["error"] == "http_503"
    assert jobs[0]["description"] == "Support computers."
    assert jobs[0]["category"] == "it_support"
    assert jobs[1]["description"] is None and not jobs[1]["auto_apply_eligible"]
    pages["https://example.com/jobs/show_more?page=2"] = card.format(id=123)
    jobs, health = discover_company_career_site("Example", root, fetcher=fetch)
    assert len(jobs) == 1 and "repeated" in health["error"]


def test_workable_embed_reads_all_jobs_and_rejects_executable_suffix():
    root = "https://example.com/careers"
    html = '<script src="https://www.workable.com/assets/embed.js"></script><script>whr_embed(123, {});</script>'
    row = {
        "title": "IT Support Analyst",
        "url": "https://apply.workable.com/j/ABC",
        "published_on": "2026-10-01",
        "created_at": "2020-01-01",
        "locations": [{"country": "Canada", "city": "Toronto"}],
        "description": "<p>Support users.</p><h2>Requirements</h2><p>Networking.</p>",
    }
    payload = (
        "/**/whrcallback("
        + json.dumps(
            {
                "jobs": [
                    {**row, "locations": [{"country": "United States"}]},
                    row,
                    row,
                    {**row, "url": "https://apply.workable.com/j/DEF", "description": ""},
                ]
            }
        )
        + ");"
    )
    calls = []

    def fetch(url):
        calls.append(url)
        return html if url == root else payload

    jobs, health = discover_company_career_site("Example", root, fetcher=fetch)
    assert len(jobs) == 2 and health["error"] == "description_not_found"
    assert "details=true" in calls[-1]
    assert jobs[0]["date_posted"] == "2026-10-01"
    assert "Networking." in jobs[0]["description"]
    assert all(not j["auto_apply_eligible"] for j in jobs)
    payload += 'alert("must not execute")'
    jobs, health = discover_company_career_site("Example", root, fetcher=fetch)
    assert jobs == [] and health["status"] == "failed"


@pytest.mark.parametrize(
    "failure", ["repeat", "empty", "wrong_offset", "overlap", "count_changed", "overcount"]
)
def test_smartrecruiters_rejects_incomplete_pagination(failure):
    root = "https://careers.smartrecruiters.com/Example"

    def fetch(url):
        offset = int(parse_qs(urlsplit(url).query)["offset"][0])
        rows = [{"id": "1", "name": "Salesperson", "location": {"country": "us"}}]
        if offset and failure in {"overlap", "count_changed", "overcount"}:
            ids = (
                ["1", "2"]
                if failure == "overlap"
                else ["2", "3", "4"]
                if failure == "overcount"
                else ["2"]
            )
            rows = [{**rows[0], "id": identity} for identity in ids]
        return json.dumps(
            {
                "offset": 0 if failure == "wrong_offset" else offset,
                "totalFound": 2 if offset and failure == "count_changed" else 3,
                "content": [] if offset and failure == "empty" else rows,
            }
        )

    jobs, health = discover_company_career_site("Example", root, fetcher=fetch)
    assert jobs == [] and health["status"] == "failed"
    assert (
        health["error"]
        == {
            "repeat": "repeated_page",
            "empty": "empty_page_with_next",
            "wrong_offset": "invalid_employer_catalog",
            "overlap": "repeated_page",
            "count_changed": "catalog_changed_during_scan",
            "overcount": "catalog_count_mismatch",
        }[failure]
    )


def test_permanent_dns_and_certificate_failures_are_not_retried(monkeypatch):
    import socket
    import ssl
    from urllib.error import URLError

    from hunter import discovery_sources as sources

    sleep = Mock()
    monkeypatch.setattr(sources.time, "sleep", sleep)
    for reason, expected in [
        (ssl.SSLCertVerificationError("untrusted issuer"), "tls_certificate_error"),
        (socket.gaierror(socket.EAI_NONAME, "unknown host"), "dns_resolution_failed"),
    ]:
        failure = URLError(reason)
        fetch = Mock(side_effect=failure)
        monkeypatch.setattr(sources, "urlopen", fetch)
        with pytest.raises(URLError):
            sources.fetch_text("https://example.com")
        assert fetch.call_count == 1
        assert sources._error_code(failure) == expected
    sleep.assert_not_called()


@pytest.mark.parametrize("jobs", [[], [{"title": "IT Support"}]])
def test_jobspy_batch_never_implies_exhaustive_search(monkeypatch, jobs):
    from hunter import scraper

    record = Mock()
    monkeypatch.setattr(scraper, "record_discovery_source_health", record)
    monkeypatch.setattr(scraper, "scrape_single", Mock(return_value=jobs))
    assert scraper._scrape_jobspy_task("fallback", "IT support", "Canada", "it_support", 24) == jobs
    record.assert_called_once_with(
        "jobspy_fallback: it_support / IT support / Canada",
        status="partial",
        lead_count=len(jobs),
        error="upstream_search_completion_unverified",
    )


def test_jazzhr_public_details_remote_eligibility_and_paging_guards():
    from hunter.discovery_sources import discover_company_career_site

    base = "https://example.applytojob.com/apply"
    target = base + "/Abc123/IT-Support"
    card = f'<div class="jobs-list"><h3 class="list-group-item-heading"><a href="{target}">IT Support</a></h3></div>'
    posting = {
        "@type": "JobPosting",
        "url": target,
        "title": "IT Support",
        "description": "Support Canadian users",
        "datePosted": "2026-10-01",
        "jobLocation": {"address": {}},
        "applicantLocationRequirements": {"name": "CA"},
    }
    for changes, paging, count, error in [
        ({}, "", 1, None),
        ({"title": "Other"}, "", 1, "detail_identity_mismatch"),
        ({"description": ""}, "", 1, "description_not_found"),
        ({"validThrough": "2000-01-01"}, "", 0, None),
        ({}, f'<a rel="next" href="{base}">Next</a>', 1, "repeated_page"),
        (
            {},
            '<a rel="next" href="https://other.example/apply">Next</a>',
            1,
            "invalid_pagination_url",
        ),
    ]:

        def fetch(url):
            return (
                card + paging
                if url == base
                else '<script type="application/ld+json">'
                + json.dumps({**posting, **changes})
                + "</script>"
            )

        jobs, health = discover_company_career_site("Example", base, fetcher=fetch)
        assert len(jobs) == count and health["error"] == error
        if jobs:
            assert jobs[0]["enrichment_status"] == "blocked"
            if not error:
                assert jobs[0]["location"] == "Canada"
                assert jobs[0]["date_posted"] == "2026-10-01"
    jobs, health = discover_company_career_site("Example", base, fetcher=lambda _: "Sign in")
    assert not jobs and health["status"] == "failed"


def test_criticalmass_uses_only_its_embedded_catalog_and_not_updated_as_posted():
    from html import escape

    from hunter.discovery_sources import discover_company_career_site

    row = {
        "requisition_id": "R123",
        "title": "IT Support",
        "country": "Canada",
        "absolute_url": "https://interpublic.wd5.myworkdayjobs.com/en-US/OMC/job/Toronto/IT-Support_R123-1",
        "location": {"name": "Toronto, Canada"},
        "content": "<p>Support users</p>",
        "updated_at": "2026-10-01T00:00:00Z",
    }

    def encode(value):
        if isinstance(value, dict):
            return [0, {key: encode(item) for key, item in value.items()}]
        if isinstance(value, list):
            return [1, [encode(item) for item in value]]
        return [0, value]

    for rows, count, error in [
        ([row], 1, "posting_date_unknown"),
        ([row, row], 1, "catalog_repeated"),
        (
            [{**row, "absolute_url": row["absolute_url"].replace("interpublic", "other")}],
            0,
            "posting_identity_mismatch",
        ),
        ([{**row, "country": "United States"}], 0, None),
    ]:
        props = json.dumps({"jobData": encode({"jobs": {"Technology": rows}})})
        html = f'<astro-island component-url="/_astro/app-job-list-grid.test.js" props="{escape(props, quote=True)}"></astro-island>'
        calls = []

        def fetch(url):
            calls.append(url)
            return html

        jobs, health = discover_company_career_site(
            "Critical Mass", "https://www.criticalmass.com/jobs", fetcher=fetch
        )
        assert calls == ["https://www.criticalmass.com/jobs"]
        assert len(jobs) == count and health["error"] == error
        if jobs:
            assert jobs[0]["date_posted"] is None
            assert jobs[0]["enrichment_status"] == "blocked"
            assert jobs[0]["company"] == "Critical Mass"


def test_amazon_public_catalog_pagination_and_failure_guards():
    from hunter.discovery_sources import discover_company_career_site

    def row(identity):
        return {
            "id_icims": str(identity),
            "job_path": f"/en/jobs/{identity}/it-support",
            "title": "IT Support",
            "country_code": "CAN",
            "city": "Toronto",
            "state": "ON",
            "description": "Support users",
            "basic_qualifications": "Network skills",
            "preferred_qualifications": "Linux",
            "posted_date": "October  1, 2026",
        }

    cases = [
        ({"hits": 2, "jobs": [row(2)]}, "ok", 2),
        ({"hits": 2, "jobs": [row(1)]}, "partial", 1),
        ({"hits": 3, "jobs": [row(2)]}, "partial", 1),
        ({"hits": 2, "jobs": []}, "partial", 1),
        ({"hits": 2, "jobs": [row(2), row(3)]}, "partial", 1),
        ({"hits": 2, "jobs": [{**row(2), "country_code": "USA"}]}, "partial", 1),
        ({"hits": 2, "jobs": [{**row(2), "job_path": "https://example.com/job"}]}, "partial", 1),
        ({"hits": 2, "jobs": [{**row(2), "description": ""}]}, "partial", 2),
    ]
    for second, status, expected in cases:
        offsets = []

        def fetch(url):
            query = parse_qs(urlsplit(url).query)
            assert query["country"] == ["CAN"]
            offset = int(query["offset"][0])
            offsets.append(offset)
            return json.dumps({"hits": 2, "jobs": [row(1)]} if offset == 0 else second)

        jobs, health = discover_company_career_site(
            "Amazon / AWS", "https://www.amazon.jobs/en/search?country=CAN", fetcher=fetch
        )
        assert offsets == [0, 1]
        assert health["catalog_complete"] == (expected == 2)
        assert health["status"] == status and len(jobs) == expected
        assert "Network skills" in jobs[0]["description"]
        assert "Linux" in jobs[0]["description"]
        assert jobs[0]["location"] == "Toronto, ON, Canada"
        assert all(j["enrichment_status"] == "blocked" for j in jobs)


def test_shopify_only_reads_published_listed_jobs_linked_on_page():
    from hunter.discovery_sources import discover_company_career_site

    identity = "a58f82d8-9d35-49a4-88cd-5c7c6fbc861c"
    fields = {
        "id": identity,
        "title": "IT Support",
        "status": "Published",
        "isListed": True,
        "externalLink": "https://www.shopify.com/careers?ashby_jid=" + identity,
        "publishedDate": "2026-10-01",
        "locationName": "Americas",
    }

    def html(row, linked=True):
        nodes, node = [], {}
        for key, value in row.items():
            index = len(nodes)
            nodes.extend([key, value])
            node[f"_{index}"] = index + 1
        nodes.extend([node, node])
        script = (
            "<script>window.__reactRouterContext.streamController.enqueue("
            + json.dumps(json.dumps(nodes))
            + ");</script>"
        )
        card = (
            f'<a href="/careers/it_{identity}"><h4>IT Support</h4><div class="location">Toronto</div></a>'
            if linked
            else ""
        )
        return card + script

    jobs, health = discover_company_career_site(
        "Shopify", "https://www.shopify.com/careers", fetcher=lambda _: html(fields)
    )
    assert len(jobs) == 1 and jobs[0]["location"] == "Toronto"
    assert jobs[0]["date_posted"] == "2026-10-01"
    assert jobs[0]["enrichment_status"] == "blocked"
    assert health["status"] == "partial"
    for changes, expected_status, expected_count in [
        ({"descriptionPlain": "Support Canadian users and maintain their computers."}, "ok", 1),
        ({"descriptionPlain": ""}, "partial", 1),
        ({"descriptionPlain": "Description", "id": "other"}, "partial", 1),
        ({"descriptionPlain": "Description", "title": "Different role"}, "partial", 1),
        ({"descriptionPlain": "Description", "status": "Closed"}, "ok", 0),
        ({"descriptionPlain": "Description", "isListed": False}, "ok", 0),
    ]:
        calls = []

        def fetch(url):
            calls.append(url)
            return html(fields) if url.endswith("/careers") else html({**fields, **changes})

        jobs, health = discover_company_career_site(
            "Shopify", "https://www.shopify.com/careers", fetcher=fetch
        )
        assert health["status"] == expected_status and len(jobs) == expected_count
        assert calls == [
            "https://www.shopify.com/careers",
            f"https://www.shopify.com/careers/it_{identity}",
        ]
        if jobs:
            assert jobs[0]["enrichment_status"] == "blocked"
            assert bool(jobs[0]["description"]) == (expected_status == "ok")
    missing_identity = "b58f82d8-9d35-49a4-88cd-5c7c6fbc861c"
    missing_card = f'<a href="/careers/it_{missing_identity}"><h4>IT Support</h4></a>'
    jobs, health = discover_company_career_site(
        "Shopify",
        "https://www.shopify.com/careers",
        fetcher=lambda url: (
            html(fields) + missing_card
            if url.endswith("/careers")
            else html({**fields, "descriptionPlain": "Support Canadian users."})
        ),
    )
    assert len(jobs) == 1 and health["status"] == "partial"
    assert health["error"] == "catalog_listing_missing"
    for content in [
        html({**fields, "status": "Draft"}),
        html({**fields, "isListed": False}),
        html(fields, linked=False),
        "<html>Sign in</html>",
    ]:
        jobs, health = discover_company_career_site(
            "Shopify", "https://www.shopify.com/careers", fetcher=lambda _: content
        )
        assert not jobs and health["status"] == "failed"


def test_broad_remote_regions_are_unverified_not_confirmed_canadian():
    from hunter.discovery_policy import geography_suppression

    for location in [
        "Americas",
        "Remote - Americas",
        "Remote North America",
        "Worldwide",
        "Global",
    ]:
        assert geography_suppression(location) == "geography_unverified"
    assert geography_suppression("United States") == "outside_canada"
    assert geography_suppression("Remote Canada") is None


def test_published_greenhouse_board_setting():
    from hunter.discovery_sources import resolve_career_fetch_plan

    root = "https://example.com/careers"
    page = '<script>window.greenhouseBoardName = "coveoen";</script>'
    plan = resolve_career_fetch_plan(root, fetcher=lambda _: page)
    assert plan == {
        "method": "greenhouse",
        "url": "https://boards-api.greenhouse.io/v1/boards/coveoen/jobs?content=true",
    }
    ambiguous = page + '<a href="https://job-boards.greenhouse.io/another">Jobs</a>'
    assert (
        resolve_career_fetch_plan(root, fetcher=lambda _: ambiguous)["error"]
        == "ambiguous_career_boards"
    )
    for invalid in (
        '<p>window.greenhouseBoardName = "coveoen";</p>',
        '<script>window.greenhouseBoardName = "../other";</script>',
        '<script>window.greenhouseBoardName = "coveo" + suffix;</script>',
    ):
        assert resolve_career_fetch_plan(root, fetcher=lambda _: invalid)["method"] == "manual"


def test_rippling_public_pages_and_failures():
    import json

    from hunter.discovery_rippling import discover_rippling
    from hunter.discovery_sources import career_fetch_plan

    base = "https://ats.rippling.com/example/jobs"
    plan = career_fetch_plan("https://ats.rippling.com/embed/example/jobs")
    assert plan == {"method": "rippling", "url": base}
    assert career_fetch_plan("https://ats.rippling.com.evil/example/jobs")["method"] == "manual"
    ids = ["11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"]

    def run(fault=None):
        calls = []

        def fetch(url):
            calls.append(url)
            api = {"jobBoard": {"slug": "example"}}
            props = {"apiData": api}
            if "?page=" in url:
                page = int(url.rsplit("=", 1)[1])
                identity = ids[0 if fault == "repeat" else page]
                row = {
                    "id": identity,
                    "name": "Software Developer",
                    "locations": [{"name": "Toronto, Canada"}],
                }
                catalog = {
                    "items": [] if fault == "empty" and page else [row],
                    "page": page,
                    "totalItems": 3 if fault == "changed" and page else 2,
                    "totalPages": 2,
                }
                props["dehydratedState"] = {
                    "queries": [
                        {"queryKey": ["board", "example", "job-posts"], "state": {"data": catalog}}
                    ]
                }
            else:
                api["jobPost"] = {
                    "uuid": "wrong" if fault == "identity" else url.rsplit("/", 1)[1],
                    "name": "Software Developer",
                    "unlistedFromSearch": fault == "hidden",
                    "description": {
                        "company": "Company",
                        "role": "" if fault == "description" else "Build software",
                    },
                    "createdOn": "2026-10-01T12:00:00Z",
                }
            return (
                '<script id="__NEXT_DATA__" type="application/json">'
                + json.dumps({"props": {"pageProps": props}})
                + "</script>"
            )

        jobs, state = discover_rippling("Example", plan, fetcher=fetch)
        return jobs, state, calls

    jobs, state, calls = run()
    assert state["status"] == "ok" and len(jobs) == 2
    assert base + "?page=1" in calls
    assert all("Build software" in row["description"] for row in jobs)
    for fault in ("repeat", "empty", "changed", "identity", "hidden", "description"):
        jobs, state, _ = run(fault)
        assert state["status"] == "partial", (fault, state)
        assert state["error"]


def test_rippling_published_embed_identity():
    from hunter.discovery_sources import resolve_career_fetch_plan

    root = "https://example.com/careers"
    page = '<script src="https://static-assets.ripplingcdn.com/ats/embeds/job-board.v1.js"></script><div data-job-board-id="dialogue-en"></div>'
    assert resolve_career_fetch_plan(root, fetcher=lambda _: page) == {
        "method": "rippling",
        "url": "https://ats.rippling.com/dialogue-en/jobs",
    }
    for invalid in (
        page.replace("ripplingcdn.com", "ripplingcdn.com.evil"),
        page.replace('id="dialogue-en"', 'id="../other"'),
    ):
        assert resolve_career_fetch_plan(root, fetcher=lambda _: invalid)["method"] == "manual"
    ambiguous = page + '<div data-job-board-id="other"></div>'
    assert (
        resolve_career_fetch_plan(root, fetcher=lambda _: ambiguous)["error"]
        == "ambiguous_career_boards"
    )


def test_kula_catalog_and_detail_contract():
    import json

    from hunter.discovery_kula import discover_kula
    from hunter.discovery_sources import career_fetch_plan

    base = "https://careers.kula.ai/example"
    plan = career_fetch_plan(base)
    assert plan["method"] == "kula"
    assert career_fetch_plan("https://careers.kula.ai.evil/example")["method"] == "manual"

    def run(fault=None):
        row = {
            "id": 42,
            "title": "Software Engineer",
            "listed": fault != "hidden",
            "kind": "internal_and_external",
            "ats_job": {"offices": [{"location": "Vancouver, Canada"}]},
        }
        payload = "1:" + json.dumps({"jobs": [row, row] if fault == "repeat" else [row]})
        catalog = "<script>self.__next_f.push(" + json.dumps([1, payload]) + ")</script>"
        if fault != "missing_link":
            catalog += '<a href="/example/42-software-engineer">Apply</a>'
        detail = {
            "@type": "JobPosting",
            "title": row["title"],
            "identifier": {"value": "43" if fault == "identity" else "42"},
            "description": "" if fault == "description" else "<p>Build software</p>",
            "datePosted": "2026-10-01",
            "validThrough": "2000-01-01" if fault == "expired" else None,
        }

        def fetch(url):
            return (
                catalog
                if url == base
                else '<script type="application/ld+json">' + json.dumps(detail) + "</script>"
            )

        return discover_kula("Example", plan, fetcher=fetch)

    jobs, state = run()
    assert state["status"] == "ok" and len(jobs) == 1
    assert jobs[0]["description"] == "Build software"
    for fault in ("repeat", "missing_link", "hidden", "identity", "description"):
        jobs, state = run(fault)
        assert state["status"] in {"failed", "partial"}, (fault, state)
        assert state["error"]
    jobs, state = run("expired")
    assert jobs == [] and state["status"] == "ok"


def test_pinpoint_public_feed_and_detail_failures():
    import json

    from hunter.discovery_pinpoint import discover_pinpoint
    from hunter.discovery_sources import resolve_career_fetch_plan

    base = "https://careers.example.com/"
    identity = "11111111-1111-1111-1111-111111111111"
    target = base + "en/postings/" + identity

    def run(fault=None):
        config = {
            "showPagination": fault == "pagination",
            "url": "https://evil.test/postings.json" if fault == "foreign" else "/postings.json",
        }
        page = (
            '<a href="https://www.pinpointhq.com">Powered by</a><script data-component-name="External::Jobs">'
            + json.dumps(config)
            + "</script>"
        )
        row = {
            "url": target,
            "title": "Software Developer",
            "location": {"city": "Coquitlam", "name": "BC, Canada"},
        }
        detail = {
            "@type": "JobPosting",
            "title": row["title"],
            "identifier": {"value": "wrong" if fault == "identity" else identity},
            "description": "" if fault == "description" else "<p>Build software</p>",
            "datePosted": "2026-10-01",
        }

        def fetch(url):
            if url == base:
                return page
            if url == base + "postings.json":
                return json.dumps({"data": [row, row] if fault == "repeat" else [row]})
            assert url == target
            return '<script type="application/ld+json">' + json.dumps(detail) + "</script>"

        plan = resolve_career_fetch_plan(base, fetcher=fetch)
        assert plan["method"] == "pinpoint"
        return discover_pinpoint("Example", plan, fetcher=fetch)

    jobs, state = run()
    assert state["status"] == "ok" and jobs[0]["description"] == "Build software"
    for fault in ("pagination", "foreign", "repeat", "identity", "description"):
        _, state = run(fault)
        assert state["status"] in {"partial", "failed"}, (fault, state)
        assert state["error"]


def test_adp_one_based_paging_and_detail_contract():
    import json
    from urllib.parse import parse_qs, urlsplit

    from hunter.discovery_adp import discover_adp
    from hunter.discovery_sources import career_fetch_plan

    root = "https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=11111111-1111-1111-1111-111111111111&ccId=123_2&lang=en_CA"
    plan = career_fetch_plan(root)
    assert plan["method"] == "adp"
    assert career_fetch_plan(root.replace("adp.com", "adp.com.evil"))["method"] == "manual"

    def run(fault=None):
        starts = []

        def row(identity):
            return {
                "itemID": None if fault == "missing_identity" else "item" + identity,
                "requisitionTitle": "Software Developer",
                "customFieldGroup": {
                    "stringFields": [
                        {"nameCode": {"codeValue": "ExternalJobID"}, "stringValue": identity}
                    ],
                    "indicatorFields": [
                        {
                            "nameCode": {"codeValue": "InternalPostingFlag"},
                            "indicatorValue": fault == "hidden",
                        }
                    ],
                },
            }

        def fetch(url):
            parts = urlsplit(url)
            query = parse_qs(parts.query)
            if parts.path.endswith("job-requisitions"):
                start = int(query["$skip"][0])
                starts.append(start)
                identity = "1" if fault == "repeat" else str(start)
                return json.dumps(
                    {
                        "jobRequisitions": []
                        if fault == "empty" and start == 2
                        else [row(identity)],
                        "meta": {
                            "startSequence": start,
                            "totalNumber": 3 if fault == "changed" and start == 2 else 2,
                        },
                    }
                )
            detail = row(parts.path.rsplit("/", 1)[1])
            detail.update(
                requisitionDescription="" if fault == "description" else "<p>Build software</p>",
                postDate="2026-10-01",
            )
            if fault == "identity":
                detail["itemID"] = "wrong"
            return json.dumps(detail)

        jobs, state = discover_adp("Example", plan, fetcher=fetch)
        return jobs, state, starts

    jobs, state, starts = run()
    assert starts == [1, 2] and state["status"] == "ok" and len(jobs) == 2
    assert all(j["description"] == "Build software" for j in jobs)
    for fault in (
        "repeat",
        "empty",
        "changed",
        "hidden",
        "identity",
        "missing_identity",
        "description",
    ):
        _, state, _ = run(fault)
        assert state["status"] == "partial", (fault, state)
        assert state["error"]


def test_ukg_pagination_rejects_changed_or_repeated_pages_without_losing_prior_rows():
    from copy import deepcopy

    from hunter.discovery_ukg import _append_page

    original = {"opportunities": [{"Id": "one"}], "totalCount": 2}
    following = {"opportunities": [{"Id": "two"}], "totalCount": 2}
    catalog = deepcopy(original)
    _append_page(catalog, following)
    assert len(catalog["opportunities"]) == 2
    for bad in (
        {**following, "totalCount": 3},
        {**following, "opportunities": []},
        {**following, "opportunities": [{"Id": "one"}]},
        {**following, "opportunities": [{"Id": "two"}, {"Id": "three"}]},
    ):
        catalog = deepcopy(original)
        try:
            _append_page(catalog, bad)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid next page accepted")
        assert catalog == original


@pytest.mark.parametrize("fault", [None, "ignored_filter", "changed_link"])
def test_paradox_pagination_preserves_selected_business_unit(fault):
    from hunter.discovery_paradox import discover_paradox

    base = "https://careers.example.test/jobs"
    query = "filter%5Bcf_req_bu%5D%5B0%5D=Digital"
    calls = []

    def fetcher(url):
        calls.append(url)
        second = "/page/2" in url
        assert parse_qs(urlsplit(url).query) == {"filter[cf_req_bu][0]": ["Digital"]}
        data = {
            "params": {
                "filter": {} if second and fault == "ignored_filter" else {"cf_req_bu": ["Digital"]}
            },
            "totalJob": 2,
            "jobs": [{"uniqueID": "2" if second else "1", "title": "Cashier", "isInternal": False}],
        }
        href = "/jobs/page/2" + (
            "?filter%5Bcf_req_bu%5D%5B0%5D=Retail" if fault == "changed_link" else ""
        )
        return (
            "<script>window.__PRELOAD_STATE__ = "
            + json.dumps({"jobSearch": data})
            + ";</script>"
            + (f'<a href="{href}" aria-label="Go to next page">Next</a>' if not second else "")
        )

    jobs, health = discover_paradox(
        "Example", {"method": "paradox", "url": base + "?" + query}, fetcher=fetcher
    )
    assert jobs == []
    assert health["status"] == ("partial" if fault else "ok")
    assert health["error"] == ("search_filter_changed" if fault else None)
    assert len(calls) == (1 if fault == "changed_link" else 2)


@pytest.mark.parametrize(
    "fault", [None, "count", "tenant", "foreign_link", "identity", "description", "date", "expired"]
)
@pytest.mark.parametrize(
    "country,selection",
    [("CA", ["Canada"]), ("US", ["United States"]), ("US", []), ("US", ["Canada"])],
)
def test_recruitee_catalog_and_public_posting_validation(fault, country, selection, monkeypatch):
    from hunter import config as hunt_config

    monkeypatch.setattr(hunt_config, "DISCOVERY_COUNTRIES", selection)
    from html import escape

    from hunter.discovery_recruitee import discover_recruitee

    plan = career_fetch_plan("https://example.recruitee.com/all-of-our-positions")
    assert plan["method"] == "recruitee"
    root = "https://example.recruitee.com"
    config = {
        "site": {
            "host": "wrong.recruitee.com" if fault == "tenant" else "example.recruitee.com",
            "name": "Example Inc",
        },
        "offers": [
            {
                "externalId": 17,
                "slug": "it-support",
                "status": "published",
                "countryCode": country,
                "city": "Calgary" if country == "CA" else "Seattle",
                "translations": {
                    "en": {
                        "title": "IT Support Specialist",
                        "country": "Canada" if country == "CA" else "United States",
                    }
                },
            }
        ],
    }
    posting = {
        "@type": "JobPosting",
        "identifier": {"value": 99 if fault == "identity" else 17},
        "title": "IT Support Specialist",
        "hiringOrganization": {"name": "Example Inc"},
        "description": "" if fault == "description" else "Support computers and networks.",
        "datePosted": None if fault == "date" else "2026-10-01",
        "validThrough": "2020-01-01" if fault == "expired" else None,
    }

    def fetcher(url):
        if url == plan["url"]:
            target = (
                "https://foreign.test/o/it-support" if fault == "foreign_link" else "/o/it-support"
            )
            return (
                '<div data-component="PublicApp" data-props="'
                + escape(json.dumps({"appConfig": config}), quote=True)
                + '"></div>'
                + (
                    f'<span>{2 if fault == "count" else 1} jobs</span><a href="{target}">IT Support Specialist</a>'
                )
            )
        assert url == root + "/o/it-support"
        return (
            '<h1>IT Support Specialist</h1><script type="application/ld+json">'
            + json.dumps(posting)
            + "</script>"
        )

    jobs, health = discover_recruitee("Example", plan, fetcher=fetcher)
    if (
        country == "US"
        and selection == ["Canada"]
        and fault not in {"count", "tenant", "foreign_link"}
    ):
        assert jobs == []
        assert health["status"] == "ok"
        return
    assert health["status"] == (
        "failed"
        if fault in {"count", "tenant"}
        else "partial"
        if fault not in {None, "expired"}
        else "ok"
    )
    if fault in {"count", "tenant", "foreign_link", "expired"}:
        assert jobs == []
    else:
        assert len(jobs) == 1 and not jobs[0]["auto_apply_eligible"]
        if fault is None:
            assert jobs[0]["description"] == "Support computers and networks."
            assert jobs[0]["date_posted"] == "2026-10-01"
        elif fault == "identity":
            assert jobs[0]["description"] is None


@pytest.mark.parametrize(
    "fault", [None, "foreign", "duplicate", "title", "count", "description", "date"]
)
def test_technomedia_public_table_details_and_stable_identity(fault):
    from hunter.discovery_policy import canonical_job_key
    from hunter.discovery_technomedia import parse_catalog, read_detail

    origin = "https://careers.worksafebc.com/"
    target = ("https://foreign.test/" if fault == "foreign" else origin) + "?_opaque=one&offerid=42"
    card = f'<tr><td><a class="relink" href="{target}">Project Coordinator II</a></td><td><div class="styleColAdd3">Richmond</div></td></tr>'
    html = '<table id="CTG_JOB_LIST">' + card + (card if fault == "duplicate" else "") + "</table>"
    if fault in {"foreign", "duplicate"}:
        with pytest.raises(ValueError, match="posting_identity_mismatch|catalog_repeated"):
            parse_catalog(html, origin)
        return
    rows = parse_catalog(html, origin)
    assert len(rows) == 1 and rows[0]["location"] == "Richmond"
    assert career_fetch_plan(target)["method"] == "technomedia"
    assert canonical_job_key(target) == canonical_job_key(target.replace("one", "two"))
    assert canonical_job_key(target) != canonical_job_key(target.replace("42", "43"))
    detail = """<h1 class="TM_titlePage">Project Coordinator II</h1>
      <div id="divDrawJobPostingHeader">Posting period From 09/29/2026 to 10/14/2026</div>
      <div class="re-job-posting-panel"><h2>Overview</h2><p>Coordinate technical projects.</p></div>
      <div id="rejobpostingNavbar">Job 1&nbsp;of&nbsp;14</div>"""
    if fault == "title":
        detail = detail.replace("Project Coordinator II", "Wrong role")
    if fault == "count":
        detail = detail.replace("rejobpostingNavbar", "other")
    if fault == "description":
        detail = detail.replace("re-job-posting-panel", "other")
    if fault == "date":
        detail = detail.replace("Posting period From 09/29/2026", "Closing date")
    if fault in {"title", "count", "description"}:
        with pytest.raises(
            ValueError, match="detail_identity_mismatch|catalog_total_unknown|description_not_found"
        ):
            read_detail(detail, rows[0])
        return
    description, posted, total = read_detail(detail, rows[0])
    assert "Coordinate technical projects." in description
    assert total == 14
    assert posted == (None if fault == "date" else "2026-09-29")


def test_ukg_catalog_and_detail_contract():
    from hunter.discovery_sources import career_fetch_plan
    from hunter.discovery_ukg import discover_ukg

    base = "https://recruiting.ultipro.ca/EXAMPLE/JobBoard/736c1025-c469-4ece-a487-4884545272a7"
    plan = career_fetch_plan(base + "/?q=software")
    assert plan == {"method": "ukg", "url": base}
    assert career_fetch_plan(base.replace("ultipro.ca", "ultipro.ca.evil"))["method"] == "manual"

    def run(fault=None):
        row = {
            "Id": "9cc6dbba-8ba9-4ed1-b20f-a228d8a2999c",
            "Title": "Software Developer Intern",
            "RequisitionNumber": "SOFTW002021",
            "PostedDate": None if fault == "date" else "2026-10-01",
            "BriefDescription": "Short preview",
            "Locations": [{"Address": {"City": "Calgary", "Country": {"Name": "Canada"}}}],
        }
        if fault == "foreign":
            row["Locations"] = [
                {"Address": {"City": "Austin", "Country": {"Name": "United States"}}}
            ]
        if fault == "bad_id":
            row["Id"] = "wrong"
        rows = [row, row] if fault == "repeat" else [] if fault == "empty" else [row]
        data = {"opportunities": rows, "totalCount": 2 if fault == "pagination" else len(rows)}
        detail = {
            **row,
            "OpportunityIsClosed": fault == "closed",
            "Description": "<p>Full requirements</p>",
        }
        if fault == "identity":
            detail["RequisitionNumber"] = "different"
        if fault == "description":
            detail["Description"] = ""
        if fault == "status":
            detail.pop("OpportunityIsClosed")
        return discover_ukg(
            "Example",
            plan,
            reader=lambda _: data,
            fetcher=lambda _: (
                "<script>var opportunity = new US.Opportunity.CandidateOpportunityDetail("
                + json.dumps(detail)
                + ");</script>"
            ),
        )

    jobs, state = run()
    assert state["status"] == "ok" and len(jobs) == 1
    assert jobs[0]["description"] == "Full requirements"
    assert jobs[0]["date_posted"] == "2026-10-01"
    for fault in ("bad_id", "identity", "description", "date", "repeat", "pagination", "status"):
        _, state = run(fault)
        assert state["catalog_complete"] == (fault in {"identity", "description", "date", "status"})
        assert state["status"] in {"failed", "partial"} and state["error"], (fault, state)
    for fault in ("foreign", "closed", "empty"):
        jobs, state = run(fault)
        assert jobs == [] and state["status"] == "ok"


def test_icims_pages_and_structured_detail_contract():
    from urllib.parse import parse_qs, urlsplit

    from hunter.discovery_icims import discover_icims
    from hunter.discovery_sources import career_fetch_plan

    host = "https://careers-example.icims.com"
    plan = career_fetch_plan(host + "/jobs")
    assert plan == {"method": "icims", "url": host + "/jobs?in_iframe=1"}
    assert (
        career_fetch_plan(host.replace("icims.com", "icims.com.evil") + "/jobs")["method"]
        == "manual"
    )

    def run(fault=None):
        calls = []

        def fetch(url):
            calls.append(url)
            parts = urlsplit(url)
            if parts.path in {"/jobs", "/jobs/search"}:
                page = int(parse_qs(parts.query).get("pr", ["0"])[0]) + 1
                identity = 1 if fault == "repeat" else page
                total = 4 if fault == "changed" and page > 1 else 3
                target = host + f"/jobs/{identity}/software-developer/job?in_iframe=1"
                next_url = host + f"/jobs/search?pr={page}&in_iframe=1"
                if fault == "foreign_next":
                    next_url = "https://evil.example/jobs/search?pr=1"
                return (
                    '<div class="iCIMS_ListingsPage"><div class="iCIMS_PagingBatch">'
                    f'<a class="selected">Page {page} of {total}</a></div>'
                    '<li class="iCIMS_JobCardItem"><div class="title">'
                    f'<a href="{target}"><h3>Software Developer</h3></a></div></li>'
                    f'<div class="iCIMS_Paging"><a href="{next_url}">Next page of results</a></div></div>'
                )
            posting = {
                "@type": "JobPosting",
                "title": "Software Developer",
                "url": "wrong" if fault == "identity" else url.split("?")[0],
                "description": "" if fault == "description" else "<p>Build software</p>",
                "datePosted": None if fault == "date" else "2026-10-01",
                "jobLocation": [
                    {
                        "address": {
                            "addressCountry": "US" if fault == "foreign" else "CA",
                            "addressLocality": "Remote",
                            "addressRegion": "UNAVAILABLE",
                        }
                    }
                ],
            }
            if fault == "expired":
                posting["validThrough"] = "2000-01-01"
            return f'<script type="application/ld+json">{json.dumps(posting)}</script>'

        jobs, state = discover_icims("Example", plan, fetcher=fetch)
        return jobs, state, calls

    jobs, state, calls = run()
    assert state["status"] == "ok" and len(jobs) == 3 and len(calls) == 6
    assert all(
        j["description"] == "Build software" and j["location"] == "Remote, Canada" for j in jobs
    )
    for fault in ("identity", "description", "date", "repeat", "changed", "foreign_next"):
        _, state, calls = run(fault)
        assert state["status"] == "partial" and state["error"], (fault, state)
        assert not any("evil.example" in url for url in calls)
    for fault in ("expired", "foreign"):
        jobs, state, _ = run(fault)
        assert jobs == [] and state["status"] == "ok"


def test_okta_directory_and_full_article_contract():
    from hunter.discovery_okta import discover_okta
    from hunter.discovery_sources import career_fetch_plan

    base = "https://www.okta.com/company/careers/job-listing/"
    plan = career_fetch_plan(base)
    assert plan["method"] == "okta"
    assert career_fetch_plan(base.replace("okta.com", "okta.com.evil"))["method"] == "manual"

    def run(fault=None):
        calls = []

        def fetch(url):
            calls.append(url)
            if url.startswith(base):
                second = "page=1" in url
                slug = "software-developer-long-title" if second else "software-developer-42"
                if fault == "repeat":
                    slug = "software-developer-42"
                card = (
                    '<div class="views-row"><div class="views-field-title">'
                    f'<a href="/company/careers/rd/{slug}/">Software  Developer</a></div>'
                    '<div class="views-field-field-job-location">Toronto, Canada</div></div>'
                )
                following = "https://evil.example/" if fault == "foreign_next" else base + "?page=1"
                pager = f'<a rel="next" href="{following}">Next</a>' if not second else ""
                return '<div class="CareersView">' + card + pager + "</div>"
            title = "Wrong title" if fault == "identity" else "Software Developer"
            posting = {
                "@type": "JobPosting",
                "title": title,
                "description": "Truncated preview",
                "datePosted": None if fault == "date" else "2026-10-01",
            }
            if fault == "expired":
                posting["validThrough"] = "2000-01-01"
            if fault == "formatted_title":
                posting["title"] = "  Software&#32;Developer \n"
            article = "" if fault == "description" else "Full job requirements and responsibilities"
            return (
                f'<link rel="canonical" href="{url}"><div class="Job"><h1>{title}</h1></div>'
                f'<article class="Job__content" about="{url}">{article}</article>'
                "<form>Upload resume and submit application</form>"
                f'<script type="application/ld+json">{json.dumps(posting)}</script>'
            )

        jobs, state = discover_okta("Okta", plan, fetcher=fetch)
        return jobs, state, calls

    jobs, state, calls = run()
    assert state["status"] == "ok" and len(jobs) == 2 and len(calls) == 4
    assert all(j["description"] == "Full job requirements and responsibilities" for j in jobs)
    assert run("formatted_title")[1]["status"] == "ok"
    for fault in ("identity", "description", "date", "repeat", "foreign_next"):
        _, state, calls = run(fault)
        assert state["status"] == "partial" and state["error"], (fault, state)
        assert not any("evil.example" in url for url in calls)
    jobs, state, _ = run("expired")
    assert jobs == [] and state["status"] == "ok"


def test_hibob_catalog_contract():
    from hunter.discovery_hibob import discover_hibob
    from hunter.discovery_sources import career_fetch_plan

    plan = career_fetch_plan("https://example.careers.hibob.com/")
    assert plan == {"method": "hibob", "url": "https://example.careers.hibob.com/jobs"}
    assert career_fetch_plan("https://example.careers.hibob.com.evil/jobs")["method"] == "manual"

    def run(fault=None):
        row = {
            "id": "bad" if fault == "identity" else "446c36ce-d53f-4007-97c6-748b9a62e3c6",
            "title": "" if fault == "title" else "Software Developer",
            "site": "Calgary",
            "country": "Canada",
            "publishedAt": None if fault == "date" else "2026-10-01T16:56:30.733603179Z",
            "description": "" if fault == "description" else "<p>Build software</p>",
            "requirements": "" if fault == "description" else "<p>Python</p>",
        }
        if fault == "foreign":
            row.update(site="Berlin", country="Germany")
        rows = [row, row] if fault == "repeat" else [] if fault == "empty" else [row]
        data = {"jobAdDetails": rows, "visible_total": 3 if fault == "count" else len(rows)}
        return discover_hibob("Example", plan, reader=lambda _: data)

    jobs, state = run()
    assert state["status"] == "ok" and len(jobs) == 1
    assert jobs[0]["description"] == "Build software\nPython"
    assert jobs[0]["date_posted"] == "2026-10-01"
    assert jobs[0]["job_url"].endswith("/jobs/446c36ce-d53f-4007-97c6-748b9a62e3c6")
    for fault in ("identity", "title", "date", "description", "repeat", "count"):
        _, state = run(fault)
        assert state["status"] in {"partial", "failed"} and state["error"], (fault, state)
    for fault in ("foreign", "empty"):
        jobs, state = run(fault)
        assert jobs == [] and state["status"] == "ok"


def test_dayforce_catalog_contract():
    from hunter.discovery_dayforce import discover_dayforce
    from hunter.discovery_sources import career_fetch_plan

    plan = career_fetch_plan("https://jobs.dayforcehcm.com/en-CA/example/CANDIDATEPORTAL")
    assert plan["method"] == "dayforce"
    assert (
        career_fetch_plan(plan["url"].replace("dayforcehcm.com", "dayforcehcm.com.evil"))["method"]
        == "manual"
    )

    def run(fault=None):
        row = {
            "clientNamespace": "wrong" if fault == "tenant" else "example",
            "jobPostingId": 42,
            "jobTitle": "Software Developer",
            "jobDescription": "" if fault == "description" else "Build software",
            "postingLocations": None
            if fault == "location"
            else [{"formattedAddress": "Burnaby, Canada"}],
            "postingStartTimestampUTC": None if fault == "date" else "2026-10-01",
            "postingExpiryTimestampUTC": "2000-01-01" if fault == "expired" else None,
        }
        rows = [row, row] if fault == "repeat" else [row]
        data = {
            "jobPostings": rows,
            "offset": 0,
            "count": len(rows),
            "maxCount": 3 if fault == "pagination" else len(rows),
        }
        return discover_dayforce("Example", plan, reader=lambda _: data)

    jobs, state = run()
    assert state["status"] == "ok" and jobs[0]["description"] == "Build software"
    jobs, state = run("location")
    assert state["status"] == "ok" and jobs[0]["location"] is None
    for fault in ("tenant", "repeat", "description", "pagination", "date"):
        _, state = run(fault)
        assert state["catalog_complete"] == (fault in {"description", "date"})
        assert state["status"] in {"failed", "partial"}, (fault, state)
        assert state["error"]
    jobs, state = run("expired")
    assert jobs == [] and state["status"] == "ok"


def test_dayforce_pagination_preserves_prior_page_on_invalid_following_page():
    from copy import deepcopy

    from hunter.discovery_dayforce import _append_page

    original = {"jobPostings": [{"jobPostingId": 1}], "offset": 0, "count": 1, "maxCount": 2}
    following = {"jobPostings": [{"jobPostingId": 2}], "offset": 1, "count": 1, "maxCount": 2}
    catalog = deepcopy(original)
    _append_page(catalog, following)
    assert catalog["count"] == 2 and len(catalog["jobPostings"]) == 2
    for bad in [
        {**following, "offset": 0},
        {**following, "count": 2},
        {**following, "maxCount": 3},
        {**following, "jobPostings": []},
        {**following, "jobPostings": [{"jobPostingId": 1}]},
        {**following, "jobPostings": [{"jobPostingId": 2}, {"jobPostingId": 3}], "count": 2},
    ]:
        catalog = deepcopy(original)
        try:
            _append_page(catalog, bad)
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid pagination accepted")
        assert catalog == original


def test_jobillico_date_boundary_ignores_modal_cards_but_not_unknown_dates():
    old = (datetime.now(UTC) - timedelta(days=30)).date().isoformat()
    calls = []

    def fetch(url):
        calls.append(url)
        return f'''<select name="sort"><option value="date" selected>Date</option></select>
        <div id="jobOffersList"><article><h2><a href="/job/1">IT support</a></h2>
        <time datetime="{old}"></time></article></div>
        <div id="popupSimilarJobs"><article><h2><a href="/job/2">IT support</a></h2></article></div>
        <a class="pagination__item__link" href="/search-jobs?ipg=2">2</a>'''

    jobs, _ = discover_jobillico({"it_support": ["IT support"]}, fetcher=fetch)
    assert not jobs and len(calls) == 1
    assert parse_qs(urlsplit(calls[0]).query)["sort"] == ["date"]

    calls.clear()

    def unknown_date(url):
        html = fetch(url)
        if len(calls) == 1:
            return html.replace(f'<time datetime="{old}"></time>', "")
        raise TimeoutError()

    jobs, health = discover_jobillico({"it_support": ["IT support"]}, fetcher=unknown_date)
    assert len(calls) == 2 and len(jobs) == 1
    assert health[0]["error"] == "TimeoutError"


def test_jobillico_repeated_postings_ignore_changing_tracking_tokens():
    calls = []

    def fetch(url):
        calls.append(url)
        return f"""<article><h2><a href="/job/1?tracking={len(calls)}">IT support</a></h2></article>
        <a class="pagination__item__link" href="/search-jobs?ipg={len(calls) + 1}">{len(calls) + 1}</a>"""

    jobs, health = discover_jobillico({"it_support": ["IT support"]}, fetcher=fetch)
    assert len(calls) == 2 and len(jobs) == 1
    assert health[0]["error"] == "pagination_repeated"


@pytest.mark.parametrize("reason", ["old", "expired", "outside_canada"])
def test_builtin_reuses_excluded_detail_across_overlapping_queries(reason):
    fetched = []
    old = (datetime.now(UTC) - timedelta(days=60)).date().isoformat()

    def fetch(url):
        fetched.append(url)
        if "/jobs?" in url:
            return '<h2><a href="/job/1">IT support</a></h2>'
        posting = {
            "@type": "JobPosting",
            "title": "IT support",
            "description": "Support",
            "jobLocation": {
                "address": {"addressCountry": "US" if reason == "outside_canada" else "CA"}
            },
        }
        if reason == "old":
            posting["datePosted"] = old
        if reason == "expired":
            posting["validThrough"] = old
        return '<script type="application/ld+json">' + json.dumps(posting) + "</script>"

    jobs, _ = discover_builtin({"it_support": ["IT support", "service desk"]}, fetcher=fetch)
    assert not jobs
    assert fetched.count("https://builtin.com/job/1") == 1


@pytest.mark.parametrize("reader", [discover_jobillico, discover_builtin])
def test_public_search_streams_completed_query_before_next_query(reader):
    saved = []
    calls = []

    def fetch(url):
        calls.append(url)
        if len(calls) > (2 if reader is discover_builtin else 1):
            assert saved and saved[0][0][0]["title"] == "IT support"
            raise TimeoutError()
        if "/job/1" in url:
            return (
                '<script type="application/ld+json">'
                + json.dumps(
                    {
                        "@type": "JobPosting",
                        "title": "IT support",
                        "description": "Support",
                        "jobLocation": {"address": {"addressCountry": "CA"}},
                    }
                )
                + "</script>"
            )
        return '<article><h2><a href="/job/1">IT support</a></h2></article>'

    jobs, _ = reader(
        {"it_support": ["IT support", "service desk"]},
        fetcher=fetch,
        on_result=lambda jobs, health: saved.append((jobs, health)),
    )
    assert jobs == []  # Streamed batches are not retained a second time in memory.
    assert sum(len(batch) for batch, _ in saved) == 1
    assert (
        len([entry for _, health in saved for entry in health if entry["status"] != "running"]) == 2
    )


@pytest.mark.parametrize("identity", ["42", "wrong"])
def test_avature_card_layout_uses_published_identity_and_keeps_unknown_dates(identity):
    from hunter.discovery_sources import discover_company_career_site

    root = "https://jobs.example.com/en_US/careers/SearchJobs"
    detail = "https://jobs.example.com/en_US/careers/JobDetail/Software-Engineer/42"

    def fetch(url):
        if url == root:
            return (
                '<script src="https://templates-static-assets.avacdn.net/core.js"></script>'
                '<div class="list-controls__text">1-1 of 1 results</div>'
                '<article><h3 class="article__header__text__title"><a href="'
                + detail
                + '">Software Engineer</a></h3>'
                '<span class="list-item-location">Vancouver, Canada</span></article>'
            )
        assert url == detail
        return (
            '<h2 class="banner__text__title">Software Engineer</h2>'
            '<div class="article__content__view__field"><div class="article__content__view__field__label">Role ID</div>'
            '<div class="article__content__view__field__value">' + identity + "</div></div>"
            '<article class="article--details"><h3>Description &amp; Requirements</h3><p>Build and test software.</p></article>'
        )

    jobs, health = discover_company_career_site("Example", root, fetcher=fetch)
    assert len(jobs) == 1 and jobs[0]["date_posted"] is None
    assert health["status"] == "partial"
    assert health["error"] == (
        "posting_date_unknown" if identity == "42" else "detail_identity_mismatch"
    )
    assert bool(jobs[0]["description"]) == (identity == "42")


@pytest.mark.parametrize("failure", [None, "repeat", "changed", "identity", "date", "empty"])
def test_jibe_catalog_pagination_and_published_fields(failure):
    from urllib.parse import parse_qs, urlsplit

    from hunter.discovery_sources import discover_company_career_site

    def fetch(url):
        if "/api/jobs?" not in url:
            return '<script src="https://app.jibecdn.com/prod/cdn.js"></script>'
        page = int(parse_qs(urlsplit(url).query)["page"][0])
        assert parse_qs(urlsplit(url).query)["internal"] == ["false"]
        if failure == "empty":
            return json.dumps({"jobs": [], "totalCount": 0})
        identity = "1" if failure == "repeat" else str(page)
        row = {
            "slug": identity,
            "title": "Software Engineer",
            "client_code": "example",
            "country": "Canada",
            "description": "<p>Build software.</p>",
            "posted_date": "2026-10-01T00:00:00+0000",
            "employment_type": "FULL_TIME",
            "apply_url": f"https://example.icims.com/jobs/{identity}/login",
        }
        if failure == "identity":
            row["apply_url"] = "https://example.icims.com/jobs/999/login"
        if failure == "date":
            row.pop("posted_date")
        return json.dumps(
            {"jobs": [{"data": row}], "totalCount": 3 if failure == "changed" and page == 2 else 2}
        )

    jobs, health = discover_company_career_site(
        "Example", "https://example.com/careers", fetcher=fetch
    )
    if failure is None:
        assert len(jobs) == 2 and health["status"] == "ok"
        assert jobs[0]["description"] == "Build software."
        assert jobs[0]["employment_type"] == "FULL_TIME"
        assert jobs[0]["auto_apply_eligible"] is False
    elif failure == "empty":
        assert jobs == [] and health["status"] == "ok"
    else:
        assert health["status"] in {"partial", "failed"}
        assert (
            health["error"]
            == {
                "repeat": "catalog_repeated",
                "changed": "catalog_count_changed",
                "identity": "application_identity_mismatch",
                "date": "posting_date_unknown",
            }[failure]
        )
    assert health["catalog_complete"] == (failure in {None, "date", "empty"})


def test_builtin_skips_old_card_details_without_stopping_pagination():
    from hunter.discovery_sources import discover_builtin

    fetched = []

    def fetch(url):
        fetched.append(url)
        if "/jobs?" in url:
            return (
                '<div data-id="job-card"><h2><a href="/job/old/1">Software Engineer</a></h2>'
                '<span><i class="fa-clock"></i>30 Days Ago</span></div>'
                '<div data-id="job-card"><h2><a href="/job/new/2">Software Engineer</a></h2>'
                '<span><i class="fa-clock"></i>1 Day Ago</span></div>'
            )
        assert url.endswith("/job/new/2")
        return (
            '<script type="application/ld+json">'
            + json.dumps(
                {
                    "@type": "JobPosting",
                    "title": "Software Engineer",
                    "hiringOrganization": {"name": "Example"},
                    "jobLocation": {"address": {"addressCountry": "Canada"}},
                    "description": "Build software",
                }
            )
            + "</script>"
        )

    jobs, _ = discover_builtin({"engineering": ["software engineer"]}, hours_old=336, fetcher=fetch)
    assert len(jobs) == 1
    assert not any(url.endswith("/job/old/1") for url in fetched)


@pytest.mark.parametrize(
    "fault",
    [None, "empty", "count", "repeat", "foreign", "identity", "description", "non_exhaustive"],
)
def test_smartdreamers_public_catalog_preserves_partial_evidence(fault, monkeypatch):
    from urllib.parse import parse_qs

    from hunter import config
    from hunter.discovery_smartdreamers import discover_smartdreamers
    from hunter.discovery_sources import resolve_career_fetch_plan

    monkeypatch.setattr(config, "DISCOVERY_COUNTRIES", ["Canada"])
    base = "https://careers.example.test/jobs"
    target = "https://careers.example.test/global-careers/company-job/description/reqid/123BR"
    page_html = '<img src="https://res.cloudinary.com/smartdreamers/logo.png"><script src="https://cdn.example.test/assets/merged/js/search.js"></script>'

    def fetcher(url):
        if url == base:
            return page_html
        if url.endswith("search.js"):
            return "const c=algoliasearch('PUBLICAPP','publicsearchkey');const s={indexName:'public_jobs'};"
        assert url in {target, target.replace("123BR", "124BR")}
        return (
            '<div class="page-headline">IT Support</div><p id="custom_field_reqid">'
            + ("wrong" if fault == "identity" else url.rsplit("/", 1)[-1])
            + "</p>"
            + '<div class="description-content"><div class="description-page-right">'
            + ("" if fault == "description" else "Support the office computers and networks.")
            + "</div></div>"
        )

    calls = []

    def poster(url, payload, *, headers):
        assert url == "https://publicapp-dsn.algolia.net/1/indexes/*/queries"
        assert headers["X-Algolia-Application-Id"] == "PUBLICAPP"
        q = parse_qs(payload["requests"][0]["params"])
        assert json.loads(q["facetFilters"][0]) == [["country:Canada"]]
        page = int(q["page"][0])
        calls.append(page)
        posting = target.replace("123BR", str(123 if fault == "repeat" else 123 + page) + "BR")
        row = {
            "objectID": "Job::" + str(1 if fault == "repeat" else page + 1),
            "title": "IT Support",
            "redirect_url": [
                posting.replace("careers.example.test", "foreign.test")
                if fault == "foreign"
                else posting
            ],
            "reqid": [posting.rsplit("/", 1)[-1]],
            "work_location": ["Toronto"],
            "country": ["Canada"],
        }
        return {
            "results": [
                {
                    "hits": [] if fault == "empty" or fault == "count" and page == 1 else [row],
                    "nbHits": 0 if fault == "empty" else 2,
                    "page": page,
                    "index": "public_jobs",
                    "exhaustiveNbHits": fault != "non_exhaustive",
                }
            ]
        }

    plan = resolve_career_fetch_plan(base, fetcher=fetcher)
    assert plan["method"] == "smartdreamers"
    jobs, health = discover_smartdreamers("Example", plan, fetcher=fetcher, poster=poster)
    assert health["catalog_complete"] == (fault in {None, "empty", "identity", "description"})
    if fault == "empty":
        assert jobs == [] and health["status"] == "ok"
    elif fault in {"foreign", "non_exhaustive"}:
        assert jobs == [] and health["status"] == "failed"
    else:
        assert health["status"] == "partial"
        assert len(jobs) == (1 if fault in {"repeat", "count"} else 2)
        assert all(not job["auto_apply_eligible"] for job in jobs)
        if fault is None:
            assert health["error"] == "posting_date_unknown"
            assert all(job["description"] for job in jobs)
        if fault in {"identity", "description"}:
            assert all(not job["description"] for job in jobs)
    assert len(calls) <= 2
    if fault is None:
        from hunter.company_preview import preview_company

        preview = preview_company("Example", base, fetcher=fetcher, poster=poster)
        assert preview["saved"] is False and preview["matched"] == 2
        assert preview["requests"] <= 12
        assert preview["plan"]["method"] == "smartdreamers"


@pytest.mark.parametrize(
    "case",
    [
        "no_match",
        "student",
        "matching",
        "empty",
        "missing_total",
        "repeat",
        "changed",
        "truncated",
        "foreign",
        "extra",
        "limit",
    ],
)
def test_gc_catalog_completion_is_independent_of_profile_matches(monkeypatch, case):
    from contextlib import nullcontext
    from unittest.mock import Mock

    from hunter import discovery_browser

    def page(identity, total, following=False):
        count = f'<a href="page2440?tab=1">Jobs open to the public ({total})</a>'
        row = (
            (
                f'<li class="searchResult"><strong><a href="/psrs-srfp/applicant/page1800?poster={identity}">Software Engineer Intern</a></strong>'
                '<div class="tableCell">Closing date: 2099-01-01<br>Example Department<br>Ottawa (Ontario)</div></li>'
            )
            if identity
            else ""
        )
        return count + row + ('<a href="page2440?requestedPage=next">Next</a>' if following else "")

    pages = [page("1", 2, True), page("2", 2)]
    if case == "student":
        pages[1] = page("1", 2).replace("/psrs-srfp/applicant/page1800", "/srs-sre/page01.html")
    if case == "empty":
        pages = [page(None, 0)]
    if case == "missing_total":
        pages[0] = pages[0].replace("Jobs open to the public (2)", "Search")
    if case == "repeat":
        pages[1] = page("1", 2)
    if case == "changed":
        pages[1] = page("2", 3)
    if case == "truncated":
        pages = [page("1", 2)]
    if case == "foreign":
        pages[0] = pages[0].replace(
            'href="/psrs-srfp/applicant/page1800',
            'href="https://foreign.example/psrs-srfp/applicant/page1800',
        )
    if case == "extra":
        pages = [page("1", 0)]
    browser = Mock()
    browser.new_page.return_value.content.side_effect = pages
    browser.new_page.return_value.url = (
        "https://emploisfp-psjobs.cfp-psc.gc.ca/psrs-srfp/applicant/page2440"
    )
    monkeypatch.setattr(discovery_browser, "open_public_browser", lambda: nullcontext(browser))
    if case != "matching":
        monkeypatch.setattr(discovery_browser, "matching_search_lane", lambda title: None)
    saved = []
    jobs, health = discovery_browser.discover_gc_jobs(
        max_pages=1 if case == "limit" else None, on_result=lambda rows, state: saved.extend(rows)
    )
    assert saved == jobs
    result = health[0]
    assert result["catalog_complete"] == (case in {"no_match", "matching", "empty", "student"})
    expected = {
        "no_match": None,
        "student": None,
        "matching": "posting_dates_and_application_links_unverified",
        "empty": None,
        "missing_total": "catalog_count_missing",
        "repeat": "pagination_repeated",
        "changed": "catalog_changed_during_scan",
        "truncated": "catalog_count_mismatch",
        "foreign": "posting_identity_mismatch",
        "extra": "catalog_count_mismatch",
        "limit": "page_limit_reached",
    }
    assert result["error"] == expected[case]
    assert result["status"] == (
        "ok"
        if case in {"no_match", "empty", "student"}
        else "partial"
        if case == "matching"
        else "failed"
    )
    assert len(jobs) == (2 if case == "matching" else 0)


def test_gc_employer_routing_and_preview_use_existing_reader(monkeypatch):
    from hunter import discovery_browser
    from hunter.company_preview import preview_company
    from hunter.discovery_sources import discover_company_career_site

    url = "https://emploisfp-psjobs.cfp-psc.gc.ca/psrs-srfp/applicant/page2440?fromMenu=true&toggleLanguage=en"

    def reader(**kwargs):
        assert kwargs == {"url": url}
        return [], [
            {
                "source": "gc_jobs",
                "status": "ok",
                "error": None,
                "lead_count": 0,
                "catalog_complete": True,
            }
        ]

    monkeypatch.setattr(discovery_browser, "discover_gc_jobs", reader)

    def unused(*args, **kwargs):
        raise AssertionError("Browser preview must not run a scan")

    preview = preview_company("Government of Canada", url, fetcher=unused)
    assert preview["status"] == "needs_scan"
    assert preview["plan"]["method"] == "gc_jobs"
    jobs, health = discover_company_career_site("Government of Canada", url, fetcher=unused)
    assert jobs == [] and health["catalog_complete"] and health["status"] == "ok"


def test_smartrecruiters_malformed_listing_does_not_prove_catalog_complete():
    from hunter.discovery_sources import discover_smartrecruiters

    jobs, health = discover_smartrecruiters(
        "Example",
        {"url": "https://api.smartrecruiters.com/v1/companies/Example/postings"},
        fetcher=lambda _: json.dumps(
            {"offset": 0, "totalFound": 1, "content": [{"id": "invalid"}]}
        ),
    )
    assert jobs == []
    assert health["status"] == "partial"
    assert health["error"] == "invalid_employer_listing"
    assert health["catalog_complete"] is False


def test_country_limited_sources_report_unsearched_geography(monkeypatch):
    from hunter import config

    monkeypatch.setattr(config, "DISCOVERY_COUNTRIES", ["Canada"])
    assert config.discovery_geography_limits() == []
    monkeypatch.setattr(config, "DISCOVERY_COUNTRIES", ["Canada", "United States"])
    limits = config.discovery_geography_limits()
    assert any(
        r["source"] == "job_bank" and r["unsearched_countries"] == ["United States"] for r in limits
    )
    monkeypatch.setattr(config, "DISCOVERY_COUNTRIES", [])
    assert config.discovery_geography_limits()


def test_jobright_search_response_matches_the_requested_query_and_page():
    from unittest.mock import Mock

    from hunter.discovery_jobright import _search_response

    response = Mock(url="https://jobright.ai/swan/recommend/search?position=0&sortCondition=1")
    response.request.post_data_json = {"value": "registered nurse"}
    assert _search_response(response, term="registered nurse", position=0)
    assert not _search_response(response, term="data analyst", position=0)
    assert not _search_response(response, term="registered nurse", position=10)
    response.url = "https://jobright.ai.evil.test/swan/recommend/search?position=0"
    assert not _search_response(response)


@pytest.mark.parametrize("total,expected", [(1, "ok"), (2, "partial")])
@pytest.mark.parametrize("countries", [["Canada"], ["Canada", "United States"], []])
def test_jobright_search_does_not_call_a_short_catalog_complete(
    monkeypatch, tmp_path, total, expected, countries
):
    from unittest.mock import MagicMock, Mock

    import playwright.sync_api

    from hunter import config
    from hunter import discovery_jobright as module

    monkeypatch.setattr(config, "DISCOVERY_COUNTRIES", countries)
    if countries != ["Canada"]:
        expected = "partial"
    payload = {
        "success": True,
        "result": {
            "jobNum": total,
            "jobList": [
                {
                    "jobResult": {
                        "jobId": "1",
                        "jobTitle": "Junior Software Engineer",
                        "publishTime": "2026-10-04",
                        "jobLocation": "Canada",
                        "originalUrl": "https://example.test/jobs/1",
                    },
                    "companyResult": {"companyName": "Example"},
                }
            ],
        },
    }
    response = Mock()
    response.value.json.return_value = payload
    response.value.url = "https://jobright.ai/swan/recommend/search?position=0&sortCondition=1"
    context = MagicMock()
    page = context.__enter__.return_value.new_page.return_value
    page.url = "https://jobright.ai/jobs/search?country=CA&value=software+engineer"
    empty = Mock()
    empty.value.json.return_value = {"success": True, "result": {"jobNum": total, "jobList": []}}
    page.expect_response.return_value.__enter__.return_value = empty
    monkeypatch.setattr(playwright.sync_api, "sync_playwright", MagicMock())
    monkeypatch.setattr(module, "_jobright_context", lambda *a: context)
    monkeypatch.setattr(module, "_load_recommendations", Mock())
    monkeypatch.setattr(module, "_load_search", Mock(return_value=response))
    session = tmp_path / "session.json"
    session.write_text("{}")
    jobs, health = module.discover_jobright(
        storage_state=session, search_terms={"engineering": ["software engineer"]}, hours_old=100000
    )
    assert len(jobs) == 1
    assert health[1]["status"] == expected
    if total == 2:
        assert health[1]["error"].startswith("catalog_count_mismatch")
    page.close.assert_called_once()
