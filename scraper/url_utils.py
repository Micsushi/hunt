from urllib.parse import parse_qs, unquote, urlparse

import pandas as pd


ATS_HOST_SUFFIXES = {
    "greenhouse": ("greenhouse.io",),
    "lever": ("lever.co",),
    "workday": ("myworkdayjobs.com", "workday.com"),
    "ashby": ("ashbyhq.com",),
    "smartrecruiters": ("smartrecruiters.com",),
    "jobvite": ("jobvite.com",),
    "icims": ("icims.com",),
    "bamboohr": ("bamboohr.com",),
}

LINKEDIN_REDIRECT_QUERY_KEYS = (
    "url",
    "redirect",
    "redirect_url",
    "dest",
    "dest_url",
)


def is_missing_value(value):
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def normalize_optional_str(value):
    if is_missing_value(value):
        return None
    normalized = str(value).strip()
    return normalized or None


def normalize_http_url(url):
    normalized = normalize_optional_str(url)
    if not normalized:
        return None

    parsed = urlparse(normalized)
    if parsed.scheme.lower() not in ("http", "https"):
        return None
    if not parsed.netloc:
        return None
    return normalized


def looks_like_linkedin_url(url):
    normalized = normalize_http_url(url)
    if not normalized:
        return False
    host = (urlparse(normalized).netloc or "").lower()
    return host.endswith("linkedin.com")


def _decode_query_value(value):
    decoded = normalize_optional_str(value)
    if not decoded:
        return None

    for _ in range(2):
        decoded = unquote(decoded)
    return decoded


def unwrap_known_redirect_url(url):
    normalized = normalize_http_url(url)
    if not normalized:
        return None

    parsed = urlparse(normalized)
    query = parse_qs(parsed.query)
    for key in LINKEDIN_REDIRECT_QUERY_KEYS:
        values = query.get(key, [])
        for value in values:
            candidate = normalize_http_url(_decode_query_value(value))
            if candidate:
                return candidate
    return normalized


def normalize_apply_url(url):
    normalized = unwrap_known_redirect_url(url)
    return normalize_http_url(normalized)


def get_apply_host(url):
    normalized = normalize_apply_url(url)
    if not normalized:
        return None
    host = (urlparse(normalized).netloc or "").lower()
    return host or None


def detect_ats_type(url):
    host = get_apply_host(url)
    if not host:
        return None

    for ats_type, suffixes in ATS_HOST_SUFFIXES.items():
        if any(host.endswith(suffix) for suffix in suffixes):
            return ats_type
    return "unknown"
