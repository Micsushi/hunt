from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

from hunter import discovery_linkedin as module


def card(identity, title="IT Support"):
    return (
        f'<div class="base-search-card"><a class="base-card__full-link" '
        f'href="https://ca.linkedin.com/jobs/view/it-support-{identity}?trackingId=ignored"></a>'
        f'<h3 class="base-search-card__title">{title}</h3>'
        '<h4 class="base-search-card__subtitle">Example</h4>'
        '<span class="job-search-card__location">Toronto, Canada</span>'
        '<time datetime="2026-10-01"></time></div>'
    )


def test_linkedin_offsets_use_all_cards_not_accumulated_or_matching_jobs(monkeypatch):
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    offsets = []
    pages = [
        card(1) + card(2, "Chef") + card(3),
        card(4) + card(5),
        card(6),
        "<!DOCTYPE html>\n<!---->",
    ]

    def fetch(url):
        offsets.append(int(parse_qs(urlsplit(url).query)["start"][0]))
        return pages.pop(0)

    jobs, health = module.discover_linkedin_query(
        "IT support", "Canada", "it_support", fetcher=fetch
    )
    assert offsets == [0, 3, 5, 6]
    assert len(jobs) == 5
    assert health["status"] == "ok"
    assert all(j["enrichment_status"] == "pending" and j["apply_url"] is None for j in jobs)
    assert all(j["auto_apply_eligible"] is None for j in jobs)


def test_linkedin_keeps_partial_results_on_rate_limit_and_detects_repeated_page(monkeypatch):
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    calls = []

    def fetch(url):
        calls.append(url)
        if len(calls) > 1:
            raise HTTPError(url, 429, "rate limited", {}, None)
        return card(1)

    jobs, health = module.discover_linkedin_query(
        "IT support", "Canada", "it_support", fetcher=fetch
    )
    assert len(jobs) == 1 and health["status"] == "partial" and health["error"] == "http_429"
    jobs, health = module.discover_linkedin_query(
        "IT support", "Canada", "it_support", fetcher=lambda _: card(1)
    )
    assert len(jobs) == 1 and health["error"] == "pagination_repeated"
    jobs, health = module.discover_linkedin_query(
        "IT support", "Canada", "it_support", fetcher=lambda _: "<h1>Sign in</h1>"
    )
    assert not jobs and health["status"] == "failed"


def test_linkedin_public_description_does_not_claim_verified_application(monkeypatch):
    monkeypatch.setattr(module.time, "sleep", lambda _: None)

    def fetch(url):
        if "/jobs/view/" in url:
            return '<div class="show-more-less-html__markup"><p>Support computers.</p></div>'
        return card(1) if parse_qs(urlsplit(url).query)["start"] == ["0"] else ""

    jobs, health = module.discover_linkedin_query(
        "IT support", "Canada", "it_support", fetcher=fetch, fetch_description=True
    )
    assert jobs[0]["description"] == "Support computers."
    assert jobs[0]["apply_url"] is None
    assert jobs[0]["enrichment_status"] == "pending"
    assert health["status"] == "ok"
