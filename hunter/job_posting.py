"""Shared readers for published schema.org JobPosting data. No script execution."""

import json
import re

from bs4 import BeautifulSoup

from hunter.url_utils import normalize_optional_str


def job_postings(soup):
    postings = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            pending = [json.loads(script.get_text())]
        except ValueError:
            continue
        while pending:
            value = pending.pop()
            if isinstance(value, list):
                pending.extend(reversed(value))
            elif isinstance(value, dict):
                types = value.get("@type", [])
                types = [types] if isinstance(types, str) else types
                if isinstance(types, list) and any(
                    kind
                    in {
                        "JobPosting",
                        "https://schema.org/JobPosting",
                        "http://schema.org/JobPosting",
                    }
                    for kind in types
                    if isinstance(kind, str)
                ):
                    postings.append(value)
                else:
                    pending.extend(
                        item for item in value.values() if isinstance(item, (dict, list))
                    )

    def microdata(scope):
        result = {}
        for element in scope.select("[itemprop]"):
            if element.find_parent(attrs={"itemscope": True}) is not scope:
                continue
            value = (
                microdata(element)
                if element.has_attr("itemscope")
                else next(
                    (
                        element[key]
                        for key in ("content", "datetime", "href", "src")
                        if element.has_attr(key)
                    ),
                    element.get_text(" ", strip=True),
                )
            )
            for key in element["itemprop"].split():
                if key in result:
                    prior = result[key]
                    result[key] = [*prior, value] if isinstance(prior, list) else [prior, value]
                else:
                    result[key] = value
        return result

    for scope in soup.select("[itemscope][itemtype]"):
        if any(value.rstrip("/").endswith("/JobPosting") for value in scope["itemtype"].split()):
            postings.append(microdata(scope))
    return postings


def posting_location(posting):
    places = posting.get("jobLocation") or []
    places = [places] if isinstance(places, dict) else places
    locations = []
    for place in places if isinstance(places, list) else []:
        address = place.get("address") if isinstance(place, dict) else None
        if not isinstance(address, dict):
            continue
        country = address.get("addressCountry")
        if isinstance(country, dict):
            country = country.get("name")
        country = {"CA": "Canada", "CAN": "Canada", "US": "United States"}.get(country, country)
        location = ", ".join(
            str(p)
            for p in (address.get("addressLocality"), address.get("addressRegion"), country)
            if p and p != "UNAVAILABLE"
        )
        if location and location not in locations:
            locations.append(location)
    if not locations:
        requirements = posting.get("applicantLocationRequirements") or []
        requirements = [requirements] if isinstance(requirements, dict) else requirements
        for place in requirements if isinstance(requirements, list) else []:
            name = place.get("name") if isinstance(place, dict) else None
            if name:
                locations.append("Canada" if name == "CA" else str(name))
    return "; ".join(locations) or None


def html_text(value, separator="\n"):
    return BeautifulSoup(value, "html.parser").get_text(separator, strip=True)


def normalize_description_text(value):
    normalized = normalize_optional_str(value)
    if not normalized:
        return None
    lines = [re.sub(r"\s+", " ", line).strip() for line in normalized.splitlines()]
    return "\n".join(line for line in lines if line) or None
