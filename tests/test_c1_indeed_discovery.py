from types import SimpleNamespace
from unittest.mock import Mock
from urllib.error import HTTPError

import pytest

from hunter.discovery_indeed import discover_indeed_query


def posting(index):
    return SimpleNamespace(
        title="IT Support",
        company="Example",
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
        return [posting(index)], str(index + 1) if index < 501 else None, False

    jobs, health = discover_indeed_query(
        "IT support",
        "Canada",
        "it_support",
        client_factory=lambda *args: client,
        page_reader=lambda client, cursor: page(cursor),
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
        (([posting(2)], "next", False), "pagination_repeated"),
    ]:
        client = SimpleNamespace(session=Mock())
        jobs, health = discover_indeed_query(
            "IT support",
            "Canada",
            "it_support",
            client_factory=lambda *args: client,
            page_reader=Mock(side_effect=[([posting(1)], "next", False), second]),
        )
        assert jobs and health["status"] == "partial" and health["error"] == expected
        client.session.close.assert_called_once()


def indeed_card(index):
    return {
        "key": str(index),
        "title": "IT Support",
        "sourceEmployerName": "Example",
        "dateOnIndeed": 1791936000000,
        "description": {"html": "<p>Support Canadian office systems.</p>"},
        "employer": None,
        "location": {"city": "Toronto", "admin1Code": "ON", "countryCode": "CA"},
        "recruit": {"viewJobUrl": f"https://ca.indeed.com/viewjob?jk={index}"},
        "attributes": [],
        "compensation": {"baseSalary": None, "currencyCode": None, "estimated": None},
    }


def indeed_response(cursor, *cards):
    response = Mock(ok=True)
    response.json.return_value = {
        "data": {
            "jobSearch": {
                "results": [{"job": card} for card in cards],
                "pageInfo": {"nextCursor": cursor},
            }
        }
    }
    return response


@pytest.mark.parametrize(
    "second_page,error",
    [
        (indeed_response(None, indeed_card(2)), None),
        (indeed_response(None, {"key": "bad"}), "indeed_search_card_invalid"),
        (Mock(ok=False, status_code=429), "http_429"),
    ],
)
def test_indeed_141_client_contract(monkeypatch, second_page, error):
    from jobspy.indeed import RequestsRotating

    monkeypatch.setattr("hunter.config.COUNTRY_INDEED", "Canada")
    requests = []
    closed = []
    responses = iter([indeed_response("fixture-next", indeed_card(1)), second_page])

    def post(session, url, **kwargs):
        requests.append((session, url, kwargs))
        return next(responses)

    monkeypatch.setattr(RequestsRotating, "post", post)
    original_close = RequestsRotating.close

    def close(session):
        closed.append(session)
        original_close(session)

    monkeypatch.setattr(RequestsRotating, "close", close)
    jobs, health = discover_indeed_query("IT support", "Canada", "it_support")
    assert health == {
        "status": "partial" if error else "ok",
        "error": error,
        "lead_count": 1 if error else 2,
    }
    assert jobs[0]["job_url"] == "https://ca.indeed.com/viewjob?jk=1"
    assert jobs[0]["apply_url"] is None
    assert jobs[0]["apply_type"] == "unknown"
    assert jobs[0]["auto_apply_eligible"] is None
    assert jobs[0]["enrichment_status"] == "pending"
    session = requests[0][0]
    assert session.headers["indeed-co"] == "CA"
    assert session.headers["indeed-locale"].endswith("-CA")
    assert all(request[2]["verify"] is True and request[2]["timeout"] == 20 for request in requests)
    assert 'where: "Canada", radius: 50' in requests[0][2]["json"]["query"]
    assert 'cursor: "fixture-next"' in requests[1][2]["json"]["query"]
    assert closed == [session]


@pytest.mark.parametrize(
    "invalid_card",
    [
        42,
        {"job": "bad shape"},
        {"job": {**indeed_card(3), "location": None}},
        {"job": {**indeed_card(3), "employer": "bad shape"}},
        {"job": {**indeed_card(3), "dateOnIndeed": 10**30}},
    ],
)
def test_indeed_keeps_valid_siblings_when_card_is_malformed(monkeypatch, invalid_card):
    from jobspy.indeed import RequestsRotating

    monkeypatch.setattr("hunter.config.COUNTRY_INDEED", "Canada")
    response = indeed_response(None, indeed_card(1), indeed_card(2))
    response.json.return_value["data"]["jobSearch"]["results"].insert(1, invalid_card)
    monkeypatch.setattr(RequestsRotating, "post", Mock(return_value=response))
    jobs, health = discover_indeed_query("IT support", "Canada", "it_support")
    assert [job["job_url"].rsplit("=", 1)[1] for job in jobs] == ["1", "2"]
    assert health == {"status": "partial", "error": "indeed_search_card_invalid", "lead_count": 2}


@pytest.mark.parametrize("country", ["Canada", "canada", "CANADA", "CA"])
def test_indeed_country_variants_and_duplicate_postings(monkeypatch, country):
    from jobspy.indeed import RequestsRotating

    monkeypatch.setattr("hunter.config.COUNTRY_INDEED", country)
    post = Mock(
        side_effect=[
            indeed_response("next", indeed_card(1)),
            indeed_response(None, indeed_card(1), indeed_card(2)),
        ]
    )
    markets = []

    def capture(session, url, **kwargs):
        markets.append(session.headers["indeed-co"])
        return post(url, **kwargs)

    monkeypatch.setattr(RequestsRotating, "post", capture)
    jobs, health = discover_indeed_query("IT support", "Canada", "it_support")
    assert [job["job_url"] for job in jobs] == [
        "https://ca.indeed.com/viewjob?jk=1",
        "https://ca.indeed.com/viewjob?jk=2",
    ]
    assert markets == ["CA", "CA"]
    assert health == {"status": "ok", "error": None, "lead_count": 2}
