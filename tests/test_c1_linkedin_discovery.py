from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit

import pytest

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


@pytest.mark.parametrize("ending", ["complete", "rate_limited", "repeated", "login"])
def test_linkedin_public_paging_reports_coverage_and_keeps_partial_results(monkeypatch, ending):
    monkeypatch.setattr(module.time, "sleep", lambda _: None)
    first = card(1) + card(2, "Chef") + card(3)
    pages = {
        "complete": [first, card(4) + card(5), card(6), "<!DOCTYPE html>\n<!---->"],
        "rate_limited": [card(1), HTTPError("https://example.test", 429, "rate limited", {}, None)],
        "repeated": [card(1), card(1)],
        "login": ["<h1>Sign in</h1>"],
    }[ending]
    offsets = []

    def fetch(url):
        offsets.append(int(parse_qs(urlsplit(url).query)["start"][0]))
        response = pages.pop(0)
        if isinstance(response, HTTPError):
            raise response
        return response

    jobs, health = module.discover_linkedin_query(
        "IT support", "Canada", "it_support", fetcher=fetch
    )
    if ending == "complete":
        assert offsets == [0, 3, 5, 6]
        assert len(jobs) == 5 and health["status"] == "ok"
        assert all(j["enrichment_status"] == "pending" and j["apply_url"] is None for j in jobs)
        assert all(j["auto_apply_eligible"] is None for j in jobs)
    elif ending == "login":
        assert not jobs and health["status"] == "failed"
    else:
        assert len(jobs) == 1 and health["status"] == "partial"
        assert health["error"] == (
            "http_429" if ending == "rate_limited" else "pagination_repeated"
        )
