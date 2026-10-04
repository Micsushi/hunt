from unittest.mock import MagicMock, Mock

import pytest

from hunter.discovery_policy import canonical_job_key
from hunter.discovery_sources import career_fetch_plan
from hunter.discovery_taleo import discover_taleo, parse_catalog, read_detail

ROOT = "https://example.taleo.net/careersection/2/jobsearch.ftl"


def catalog(identity, start=1, end=1, total=2):
    return f'{start} - {end} of {total}<table id="jobs"><tr><td><a href="/careersection/2/jobdetail.ftl?job={identity}">Software Developer</a></td></tr></table>'


def detail(identity):
    return f"""<div id="requisitionDescriptionInterface.descRequisitionContainer">
    <span id="requisitionDescriptionInterface.reqTitleLinkAction.row1">Software Developer</span>
    <span id="requisitionDescriptionInterface.reqContestNumberValue.row1">{identity}</span>
    <span id="requisitionDescriptionInterface.reqPostingDate.row1">Oct 1, 2026</span>
    <span id="requisitionDescriptionInterface.reqSiteCity.row1">Edmonton</span>
    <p>Full requirements</p></div>"""


def test_taleo_public_link_identity_and_dates():
    assert career_fetch_plan(ROOT + "?ftlcompclass=LoginComponent") == {
        "method": "taleo",
        "url": ROOT,
    }
    assert career_fetch_plan(ROOT.replace(".taleo.net", ".taleo.net.evil"))["method"] == "manual"
    rows, start, end, total = parse_catalog(catalog(123), ROOT)
    assert (start, end, total) == (1, 1, 2)
    description, posted, location = read_detail(detail(123), rows[0])
    assert "Full requirements" in description and posted == "2026-10-01" and location == "Edmonton"
    assert canonical_job_key(rows[0]["url"]) == canonical_job_key(rows[0]["url"] + "&tz=GMT-06:00")
    with pytest.raises(ValueError, match="detail_identity_mismatch"):
        read_detail(detail(456), rows[0])
    with pytest.raises(ValueError, match="posting_identity_mismatch"):
        parse_catalog(
            catalog(123).replace(
                "/careersection/2/jobdetail", "https://evil.test/careersection/2/jobdetail"
            ),
            ROOT,
        )


@pytest.mark.parametrize(
    "fault", [None, "count", "changed", "repeat", "rate_limit", "incomplete", "date", "date_count"]
)
def test_taleo_browser_retains_partial_results_and_closes(monkeypatch, fault):
    context = MagicMock()
    browser = context.__enter__.return_value.chromium.launch.return_value
    page, posting = MagicMock(), MagicMock()
    browser.new_page.side_effect = [page, posting]
    for tab in [page, posting]:
        tab.url = ROOT
        tab.goto.return_value = Mock(status=200)
    if fault == "rate_limit":
        posting.goto.return_value = Mock(status=429)
    if fault == "incomplete":
        page.wait_for_function.side_effect = [None, TimeoutError()]
    page.content.side_effect = [
        catalog(1, total=3 if fault in {"count", "date_count"} else 2),
        catalog(
            1 if fault == "repeat" else 2,
            2,
            3 if fault in {"count", "date_count"} else 2,
            3 if fault in {"count", "date_count", "changed"} else 2,
        ),
    ]
    details = [detail(1), detail(2)]
    if fault in {"date", "date_count"}:
        details = [html.replace("Oct 1, 2026", "Unknown") for html in details]
    posting.content.side_effect = details
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: context)
    jobs, state = discover_taleo("Example", {"method": "taleo", "url": ROOT})
    assert state["status"] == ("ok" if fault is None else "partial")
    assert state["catalog_complete"] == (fault in {None, "date"})
    if fault == "date":
        assert state["error"] == "posting_date_unknown"
    if fault in {"count", "date_count"}:
        assert state["error"] == "catalog_count_mismatch"
    assert (
        jobs and jobs[0]["description"] is not None
        if fault != "rate_limit"
        else jobs[0]["description"] is None
    )
    browser.close.assert_called_once()
    if fault == "rate_limit":
        posting.goto.assert_called_once()
