from types import SimpleNamespace
from unittest.mock import Mock
from urllib.error import HTTPError

from hunter.discovery_indeed import _indeed_client, discover_indeed_query


def posting(index):
    return SimpleNamespace(
        title="IT Support",
        company_name="Example",
        job_url=f"https://ca.indeed.com/viewjob?jk={index}",
        job_url_direct=None,
        description="Support Canadian office systems.",
        location=SimpleNamespace(display_location=lambda: "Toronto, ON, CA"),
        date_posted="2026-10-01",
        is_remote=False,
    )


def test_indeed_cursors_reach_end_beyond_old_result_limit():
    client = SimpleNamespace(session=Mock())
    calls = []

    def page(cursor):
        calls.append(cursor)
        index = int(cursor or 0)
        return [posting(index)], str(index + 1) if index < 501 else None

    client._scrape_page = page
    jobs, health = discover_indeed_query(
        "IT support", "Canada", "it_support", client_factory=lambda *args: client
    )
    assert len(jobs) == 502 and health["status"] == "ok"
    assert calls[0] is None and calls[-1] == "501"
    assert all(
        j["enrichment_status"] == "pending" and j["auto_apply_eligible"] is None for j in jobs
    )
    client.session.close.assert_called_once()


def test_indeed_keeps_prior_results_on_http_failure_or_repeated_cursor():
    for second, expected in [
        (HTTPError("https://example.com", 429, "limited", None, None), "http_429"),
        (([posting(2)], "next"), "pagination_repeated"),
    ]:
        client = SimpleNamespace(
            session=Mock(), _scrape_page=Mock(side_effect=[([posting(1)], "next"), second])
        )
        jobs, health = discover_indeed_query(
            "IT support", "Canada", "it_support", client_factory=lambda *args: client
        )
        assert jobs and health["status"] == "partial" and health["error"] == expected
        client.session.close.assert_called_once()


def test_indeed_owned_transport_enforces_tls_and_http_errors(monkeypatch):
    import sys

    country = SimpleNamespace(indeed_domain_value=("ca", "CA"))
    response = Mock(ok=True)
    response.json.return_value = {
        "data": {"jobSearch": {"results": [], "pageInfo": {"nextCursor": None}}}
    }
    post = Mock(return_value=response)
    client = SimpleNamespace(session=SimpleNamespace(post=post))
    monkeypatch.setitem(sys.modules, "jobspy.indeed", SimpleNamespace(Indeed=lambda: client))
    monkeypatch.setitem(
        sys.modules,
        "jobspy.model",
        SimpleNamespace(
            Country=SimpleNamespace(CANADA=country),
            Site=SimpleNamespace(INDEED="indeed"),
            ScraperInput=lambda **kwargs: SimpleNamespace(**kwargs),
        ),
    )
    owned = _indeed_client("IT support", "Canada", 24)
    owned.session.post("https://example.com", verify=False)
    assert post.call_args.kwargs["verify"] is True
    assert owned.scraper_input.distance == 50
    response.ok = False
    response.status_code = 403
    import pytest

    with pytest.raises(HTTPError):
        owned.session.post("https://example.com")
