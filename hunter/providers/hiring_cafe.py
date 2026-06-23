from __future__ import annotations

import json
import re
from dataclasses import dataclass
from html import unescape
from urllib.parse import urlencode

import requests
from bs4 import BeautifulSoup

from hunter.url_utils import (
    detect_ats_type,
    get_apply_host,
    normalize_apply_url,
    normalize_optional_str,
)

BASE_URL = "https://hiring.cafe"
SEARCH_URL = f"{BASE_URL}/"
DESCRIPTION_URL = f"{BASE_URL}/api/job-description"
DEFAULT_TIMEOUT_SECONDS = 30
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)

NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
    re.DOTALL,
)


class HiringCafeProviderError(RuntimeError):
    """Raised when the public HiringCafe page/API shape is unavailable."""


@dataclass(frozen=True)
class HiringCafeJob:
    source_id: str
    title: str | None
    company: str | None
    location: str | None
    apply_url: str | None
    description: str | None
    source: str | None
    raw: dict

    def to_hunt_job(self, *, search_url: str | None = None) -> dict:
        return {
            "title": self.title,
            "company": self.company,
            "location": self.location,
            "job_url": search_url or build_hiring_cafe_job_url(self.source_id),
            "apply_url": self.apply_url,
            "description": self.description,
            "source": "hiring_cafe",
            "apply_type": "external_apply" if self.apply_url else "unknown",
            "auto_apply_eligible": True if self.apply_url else None,
            "apply_host": get_apply_host(self.apply_url),
            "ats_type": detect_ats_type(self.apply_url),
            "external_source": self.source,
            "external_source_id": self.source_id,
        }


def build_search_state(query: str, *, days: int = 365) -> dict:
    state = {
        "searchQuery": query,
        "dateFetchedPastNDays": days,
    }
    return {key: value for key, value in state.items() if value not in (None, "")}


def build_search_url(query: str, *, days: int = 365) -> str:
    return f"{SEARCH_URL}?{urlencode({'searchState': json.dumps(build_search_state(query, days=days))})}"


def build_hiring_cafe_job_url(source_id: str) -> str:
    return build_search_url(source_id)


def _session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": BASE_URL + "/",
        }
    )
    return session


def extract_next_data(html: str) -> dict:
    match = NEXT_DATA_RE.search(html or "")
    if not match:
        raise HiringCafeProviderError("Could not find HiringCafe __NEXT_DATA__ payload.")
    try:
        return json.loads(unescape(match.group(1)))
    except json.JSONDecodeError as exc:
        raise HiringCafeProviderError("Could not decode HiringCafe __NEXT_DATA__ JSON.") from exc


def extract_search_hits(html: str) -> list[dict]:
    payload = extract_next_data(html)
    page_props = payload.get("props", {}).get("pageProps", {})
    hits = page_props.get("ssrHits")
    if hits is None:
        raise HiringCafeProviderError("HiringCafe __NEXT_DATA__ did not contain ssrHits.")
    if not isinstance(hits, list):
        raise HiringCafeProviderError("HiringCafe ssrHits payload was not a list.")
    return [hit for hit in hits if isinstance(hit, dict)]


def html_to_text(value: str | None) -> str | None:
    normalized = normalize_optional_str(value)
    if not normalized:
        return None
    soup = BeautifulSoup(normalized, "html.parser")
    text = soup.get_text("\n", strip=True)
    lines = [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]
    cleaned = "\n".join(line for line in lines if line)
    return cleaned or None


def map_hit(hit: dict, *, description_html: str | None = None) -> HiringCafeJob:
    job_information = hit.get("job_information") or {}
    processed = hit.get("v5_processed_job_data") or {}
    company_data = hit.get("enriched_company_data") or {}
    source_id = normalize_optional_str(hit.get("id") or hit.get("objectID"))
    if not source_id:
        raise HiringCafeProviderError("HiringCafe hit did not contain an id/objectID.")

    description_source = description_html or job_information.get("description")
    return HiringCafeJob(
        source_id=source_id,
        title=normalize_optional_str(
            job_information.get("title") or processed.get("core_job_title")
        ),
        company=normalize_optional_str(
            processed.get("company_name") or company_data.get("name") or hit.get("board_token")
        ),
        location=normalize_optional_str(processed.get("formatted_workplace_location")),
        apply_url=normalize_apply_url(hit.get("apply_url")),
        description=html_to_text(description_source),
        source=normalize_optional_str(hit.get("source")),
        raw=hit,
    )


def fetch_description_html(
    source_id: str,
    *,
    session: requests.Session | None = None,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> str | None:
    client = session or _session()
    response = client.get(DESCRIPTION_URL, params={"id": source_id}, timeout=timeout_seconds)
    if response.status_code == 404:
        return None
    response.raise_for_status()
    payload = response.json()
    job = payload.get("job") if isinstance(payload, dict) else None
    if not isinstance(job, dict):
        return None
    job_information = job.get("job_information") or {}
    return normalize_optional_str(job_information.get("description"))


def search_jobs(
    query: str,
    *,
    days: int = 365,
    limit: int = 10,
    include_descriptions: bool = False,
    session: requests.Session | None = None,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> list[HiringCafeJob]:
    client = session or _session()
    search_url = build_search_url(query, days=days)
    response = client.get(search_url, timeout=timeout_seconds)
    response.raise_for_status()
    hits = extract_search_hits(response.text)[: max(0, limit)]

    jobs = []
    for hit in hits:
        source_id = normalize_optional_str(hit.get("id") or hit.get("objectID"))
        description_html = None
        if include_descriptions and source_id:
            description_html = fetch_description_html(
                source_id, session=client, timeout_seconds=timeout_seconds
            )
        jobs.append(map_hit(hit, description_html=description_html))
    return jobs
