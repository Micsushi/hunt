import base64
from datetime import date
from unittest.mock import MagicMock, Mock
from urllib.parse import urlencode

import pytest

from hunter.discovery_policy import canonical_job_key
from hunter.discovery_sap import parse_catalog, posting_identity, read_description, validate_pdf_url
from hunter.discovery_sources import career_fetch_plan


def encoded(value):
    return urlencode({"PARAM": base64.b64encode(value.encode()).decode()})


def test_sap_posting_identity_and_navigation_dedup():
    identity = "3A184C14A10B1FD1AFB7DF3CEA09411E"
    # A SAP posting identity is 32 hexadecimal characters.
    identity = identity.ljust(32, "0")
    url = "https://app.bchydro.com/sap/bc/webdynpro/sap/hrrcf_a_posting_apply?" + encoded(
        f"post_inst_guid={identity}&cand_type=EXT"
    )
    assert posting_identity(url) == identity.lower()
    assert canonical_job_key(url) == canonical_job_key(url + "&sap-theme=sap_belize")
    for bad in [
        url.replace("app.bchydro.com", "app.bchydro.com.evil"),
        url.replace("https:", "http:"),
        url.split("?")[0] + "?PARAM=bad",
    ]:
        with pytest.raises(ValueError, match="posting_identity_mismatch"):
            posting_identity(bad)
    pdf = "https://app.bchydro.com/sap/bc/bsp/sap/hrrcf_wd_dovru/application.do?" + encoded(
        f"rcftype=pinst&pinst={identity}"
    )
    validate_pdf_url(pdf, identity.lower())
    with pytest.raises(ValueError, match="detail_identity_mismatch"):
        validate_pdf_url(pdf, "f" * 32)


def test_sap_catalog_and_plan():
    html = 'Search Result: 2 Hits<table><tr role="row" rr="1"><td><a role="link">IT Analyst</a></td></tr></table>'
    assert parse_catalog(html) == ([{"position": 1, "title": "IT Analyst"}], 2)
    with pytest.raises(ValueError, match="catalog_total_unknown"):
        parse_catalog("<html>Error</html>")
    with pytest.raises(ValueError, match="invalid_listing"):
        parse_catalog(html.replace('rr="1"', 'rr="bad"'))
    url = "https://app.bchydro.com/sap/bc/webdynpro/sap/hrrcf_a_unreg_job_search?sap-wd-configId=ZHRRCF_A_UNREG_JOB_SEARCH"
    assert career_fetch_plan(url) == {"method": "sap", "url": url}
    assert career_fetch_plan(url.replace("app.bchydro.com", "evil.example"))["method"] == "manual"


def test_sap_pdf_dates_and_identity():
    text = "IT Compliance Analyst\nWhat you'll do\nSupport IT.\nLocation: Vancouver, BC\nDate Posted: 2026-10-01 Closing Date: 2026-10-16"
    assert read_description(text, "IT Compliance Analyst") == (
        "2026-10-01",
        date(2026, 10, 16),
        "Vancouver, BC",
    )
    assert (
        read_description(text.replace("Date Posted:", "Unknown:"), "IT Compliance Analyst")[0]
        is None
    )
    with pytest.raises(ValueError, match="detail_identity_mismatch"):
        read_description(text, "Software Engineer")
    clipped = text.replace("IT Compliance Analyst", "IT Compliance Analyst (Vernon")
    assert read_description(clipped, "IT Compliance Analyst (Vernon)")[0] == "2026-10-01"
    with pytest.raises(ValueError, match="detail_identity_mismatch"):
        read_description(clipped, "IT Compliance Analyst (Victoria)")


@pytest.mark.parametrize("fault", [None, "changed", "incomplete", "rate_limit", "pdf_identity"])
def test_sap_browser_paging_and_cleanup(monkeypatch, fault):
    from hunter.discovery_sap import discover_sap

    plan = {
        "method": "sap",
        "url": "https://app.bchydro.com/sap/bc/webdynpro/sap/hrrcf_a_unreg_job_search",
    }
    context = MagicMock()
    browser = context.__enter__.return_value.chromium.launch.return_value
    page = browser.new_page.return_value
    page.url = plan["url"]
    page.goto.return_value = Mock(status=200)

    def catalog(position, total=2):
        return f'Search Result: {total} Hits<table><tr role="row" rr="{position}"><td><a role="link">Software Developer</a></td></tr></table>'

    page.content.side_effect = [catalog(1), catalog(2, 3 if fault == "changed" else 2)]
    if fault == "incomplete":
        page.wait_for_function.side_effect = TimeoutError()
    postings = []
    for identity in ["a" * 32, "b" * 32]:
        posting = MagicMock()
        posting.url = (
            "https://app.bchydro.com/sap/bc/webdynpro/sap/hrrcf_a_posting_apply?"
            + encoded(f"post_inst_guid={identity}&cand_type=EXT")
        )
        posting.locator.return_value.get_attribute.return_value = (
            "/sap/bc/bsp/sap/hrrcf_wd_dovru/application.do?"
            + encoded(f"rcftype=pinst&pinst={'c' * 32 if fault == 'pdf_identity' else identity}")
        )
        opened = MagicMock()
        opened.__enter__.return_value.value = posting
        postings.append((posting, opened))
    page.expect_popup.side_effect = [opened for _, opened in postings]
    page.context.request.get.return_value = Mock(
        status=429 if fault == "rate_limit" else 200,
        headers={"content-type": "application/pdf"},
        body=lambda: b"%PDF",
    )
    monkeypatch.setattr("playwright.sync_api.sync_playwright", lambda: context)
    monkeypatch.setattr(
        "hunter.discovery_sap.extract_text",
        lambda _: "Software Developer\nWhat you'll do\nBuild tools.\nDate Posted: 2026-10-01",
    )
    jobs, health = discover_sap("BC Hydro", plan)
    assert health["status"] == ("ok" if fault is None else "partial")
    assert len(jobs) == (
        2 if fault is None else 0 if fault in {"rate_limit", "pdf_identity"} else 1
    )
    browser.close.assert_called_once()
    postings[0][0].close.assert_called_once()
    if fault == "rate_limit":
        page.expect_popup.assert_called_once()
        page.get_by_role.assert_not_called()
    else:
        page.get_by_role.return_value.press.assert_called_once_with("PageDown")
    if fault == "pdf_identity":
        page.context.request.get.assert_not_called()
