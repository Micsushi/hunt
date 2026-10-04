"""Read public Paycor/Newton listings without entering the application flow."""

import re
from urllib.parse import parse_qs, urljoin, urlsplit

from bs4 import BeautifulSoup

from hunter.discovery_policy import outside_geography
from hunter.discovery_sources import _job, catalog_error, fetch_text
from hunter.search_lanes import matching_search_lane


def discover_paycor(company, plan, *, fetcher=fetch_text):
    jobs, seen, error = [], set(), None
    try:
        client = parse_qs(urlsplit(plan["url"]).query)["clientId"]
        soup = BeautifulSoup(fetcher(plan["url"]), "html.parser")
        form = soup.select_one('form[name="candidateHome"]')
        tenant = form.select_one('input[name="clientId"]') if form else None
        if tenant is None or [tenant.get("value")] != client:
            raise ValueError("board_identity_mismatch")
        cards = form.select(".gnewtonCareerGroupRowClass")
        # This layout publishes no total or end cursor. Never claim exhaustive coverage.
        error = "catalog_total_unknown"
        for card in cards:
            link = card.select_one(".gnewtonCareerGroupJobTitleClass a[href]")
            if link is None:
                raise ValueError("invalid_listing")
            target = urljoin(plan["url"], link["href"])
            parts = urlsplit(target)
            query = parse_qs(parts.query)
            identity = query.get("id", [""])
            if (
                parts.scheme != "https"
                or parts.hostname != "recruitingbypaycor.com"
                or parts.path != "/career/JobIntroduction.action"
                or query.get("clientId") != client
                or len(identity) != 1
                or not re.fullmatch(r"[a-f0-9]{32}", identity[0])
            ):
                raise ValueError("posting_identity_mismatch")
            if identity[0] in seen:
                raise ValueError("catalog_repeated")
            seen.add(identity[0])
            title = link.get_text(" ", strip=True)
            location_node = card.select_one(".gnewtonCareerGroupJobDescriptionClass")
            location = location_node.get_text(" ", strip=True) if location_node else ""
            if outside_geography(location) or not matching_search_lane(title):
                continue
            description = None
            try:
                detail = BeautifulSoup(fetcher(target), "html.parser")
                application = detail.select_one("form#gravityApplyJob[action]")
                action = urlsplit(urljoin(target, application["action"])) if application else None
                heading = detail.select_one("#gnewtonJobPosition")
                if heading:
                    for label in heading.select("b"):
                        label.decompose()
                if (
                    action is None
                    or action.scheme != "https"
                    or action.hostname != parts.hostname
                    or action.path != "/career/SubmitResume.action"
                    or parse_qs(action.query).get("clientId") != client
                    or parse_qs(action.query).get("id") != identity
                    or heading is None
                    or heading.get_text(" ", strip=True).strip(" \u00a0\ufffd") != title
                ):
                    raise ValueError("detail_identity_mismatch")
                content = detail.select_one("#gnewtonJobDescriptionText")
                if content is None or not content.get_text(strip=True):
                    raise ValueError("description_not_found")
                description = content.get_text("\n", strip=True)
                employer_location = detail.select_one("#gnewtonJobLocationInfo")
                location = employer_location.get_text(" ", strip=True) if employer_location else ""
            except Exception as exc:
                error = catalog_error(exc)
            jobs.append(
                _job(
                    title=title,
                    company=company,
                    location=location,
                    url=target,
                    source="employer_paycor",
                    description=description,
                )
            )
    except Exception as exc:
        error = catalog_error(exc)
    return jobs, {
        **plan,
        "status": "partial" if seen else "failed",
        "error": error,
        "lead_count": len(jobs),
    }
