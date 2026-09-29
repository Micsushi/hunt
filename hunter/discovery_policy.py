"""Deterministic C1 discovery policy shared by every source adapter."""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from hunter.config import TITLE_BLACKLIST, WATCHLIST

EMPLOYER_ALIASES = {
    "amazon web services": "amazon",
    "aws": "amazon",
    "bank of montreal": "bmo",
    "bmo financial group": "bmo",
    "demonware": "activision",
    "dragonfly": "intelcom",
    "equitable bank": "eq bank",
    "intelcom": "intelcom",
    "loblaw digital": "loblaw",
    "royal bank of canada": "rbc",
    "sap concur": "sap",
    "slack": "salesforce",
    "td bank": "td",
}

TRACKING_QUERY_KEYS = {
    "fbclid",
    "gclid",
    "ref",
    "referrer",
    "source",
    "trk",
    "trackingid",
}

SENIOR_TITLE = re.compile(
    r"\b(?:senior|staff|principal|director|head of|vice president|vp|chief|manager ii|manager iii)\b",
    re.IGNORECASE,
)
EARLY_TITLE = re.compile(
    r"\b(?:intern(?:ship)?|co[ -]?op|student|new grad(?:uate)?|graduate|early career|"
    r"entry[ -]?level|junior|jr\.?|associate|university)\b",
    re.IGNORECASE,
)
INTERN_TITLE = re.compile(r"\b(?:intern(?:ship)?|co[ -]?op|student)\b", re.IGNORECASE)
NEW_GRAD_TITLE = re.compile(
    r"\b(?:new grad(?:uate)?|graduate|early career|entry[ -]?level|junior|jr\.?|associate)\b",
    re.IGNORECASE,
)
CANADA_LOCATION = re.compile(
    r"\b(?:canada|ontario|quebec|alberta|british columbia|manitoba|"
    r"saskatchewan|nova scotia|new brunswick|newfoundland|prince edward island|"
    r"yukon|northwest territories|nunavut|toronto|vancouver|montreal|montréal|"
    r"ottawa|calgary|edmonton|winnipeg|halifax|waterloo|kitchener|"
    r"st[.]? john['’]?s|charlottetown|summerside|corner brook)\b",
    re.IGNORECASE,
)


def normalize_text(value: object) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def normalize_company(value: object) -> str:
    name = normalize_text(value)
    return EMPLOYER_ALIASES.get(name, name)


def normalize_job_url(value: object) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    parts = urlsplit(raw)
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        return None
    query = [
        (key, item)
        for key, item in parse_qsl(parts.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in TRACKING_QUERY_KEYS
    ]
    host = (parts.hostname or "").lower()
    netloc = host
    if parts.port is not None:
        netloc = f"{host}:{parts.port}"
    return urlunsplit((parts.scheme.lower(), netloc, parts.path.rstrip("/"), urlencode(query), ""))


def canonical_job_key(url: object, company: object = "") -> str:
    normalized = normalize_job_url(url)
    if not normalized:
        return ""
    parts = urlsplit(normalized)
    host = (parts.hostname or "").removeprefix("www.")
    path = re.sub(r"/(?:apply|application)$", "", parts.path, flags=re.IGNORECASE)
    query = dict(parse_qsl(parts.query))
    employer = normalize_company(company)

    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io"}:
        match = re.search(r"^/([^/]+)/jobs/([^/]+)$", path)
        if match:
            return f"greenhouse:{match.group(1).lower()}:{match.group(2).lower()}"
        board = re.fullmatch(r"/([^/]+)", path)
        if board and query.get("gh_jid"):
            return f"greenhouse:{board.group(1).lower()}:{query['gh_jid'].lower()}"

    for field in ("gh_jid", "job_id", "jobId", "jid"):
        if query.get(field):
            return f"requisition:{employer}:{query[field].lower()}"
    if "myworkdayjobs.com" in host:
        match = re.search(r"_([A-Z]+[A-Z0-9_-]*\d)(?:/|$)", path, re.IGNORECASE)
        if match:
            requisition = re.sub(r"[-_]1$", "", match.group(1), flags=re.IGNORECASE)
            return f"workday:{host.split('.')[0]}:{requisition.lower()}"
    match = re.search(r"/(?:jobs|careers|job)/([0-9a-f-]{6,})(?:/|$)", path, re.IGNORECASE)
    if match:
        return f"{host}:{match.group(1).lower()}"
    identity_query = urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True)))
    return f"{host}{path}".lower() + (f"?{identity_query}" if identity_query else "")


def classify_career_stage(title: object) -> str:
    value = str(title or "")
    if SENIOR_TITLE.search(value):
        return "experienced_excluded"
    if EARLY_TITLE.search(value):
        return "early_career"
    return "unstated_stretch"


def priority_tier(title: object) -> str:
    value = str(title or "")
    if INTERN_TITLE.search(value):
        return "P2"
    if NEW_GRAD_TITLE.search(value) and re.search(
        r"\b(?:software|developer|engineer|frontend|backend|full[ -]?stack|devops|cloud|platform)\b",
        value,
        re.IGNORECASE,
    ):
        return "P1"
    return "P3"


def is_canadian_location(location: object) -> bool:
    value = str(location or "")
    for place in re.split(r"[;|\n]", value):
        if re.search(r"\bcanada\b", place, re.IGNORECASE):
            return True
        if re.search(r"\b(?:united states|usa|united kingdom)\b", place, re.IGNORECASE):
            continue
        # JobSpy emits Canadian Indeed locations as "Toronto, ON, CA".
        # A province disambiguates the final CA country code from California.
        if re.search(
            r"(?:^|,\s*)(?:ON|QC|AB|BC|MB|SK|NS|NB|YT|NT|NU)\s*(?:$|,)", place
        ) or re.search(r",\s*(?:NL|PE)\s*,\s*CA\s*$", place):
            return True
        # Explicit US state/country evidence overrides ambiguous Canadian city names.
        if re.search(
            r",\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b",
            place,
        ):
            continue
        if CANADA_LOCATION.search(place):
            return True
    return False


def geography_suppression(location: object) -> str | None:
    if is_canadian_location(location):
        return None
    if normalize_text(location) in {"", "remote", "worldwide", "remote worldwide", "anywhere"}:
        return "geography_unverified"
    return "outside_canada"


def score_job(job: dict) -> tuple[int, int, str | None]:
    """Return fit, viability, and a non-destructive suppression reason."""
    stage = classify_career_stage(job.get("title"))
    tier = priority_tier(job.get("title"))
    fit = {"P1": 90, "P2": 85, "P3": 65}[tier]
    if stage == "unstated_stretch":
        fit -= 10
    viability = 25
    if job.get("apply_url"):
        viability += 35
    if job.get("description"):
        viability += 15
    if job.get("date_posted"):
        viability += 10
    if job.get("apply_type") == "external_apply":
        viability += 15

    reason = None
    if any(word.lower() in str(job.get("title") or "").lower() for word in TITLE_BLACKLIST):
        reason = "title_blacklist"
    elif stage == "experienced_excluded":
        reason = "experienced_title"
    elif geography_reason := geography_suppression(job.get("location")):
        reason = geography_reason
    elif job.get("category") == "other":
        reason = "outside_search_lanes"
    elif job.get("apply_type") == "easy_apply":
        reason = "easy_apply_ineligible"
    elif result_url := normalize_job_url(job.get("apply_url")):
        if (urlsplit(result_url).hostname or "").lower().endswith("linkedin.com"):
            reason = "linkedin_only_apply_path"
    return max(0, min(fit, 100)), max(0, min(viability, 100)), reason


def annotate_job(job: dict) -> dict:
    result = dict(job)
    result["job_url"] = normalize_job_url(result.get("job_url"))
    result["apply_url"] = normalize_job_url(result.get("apply_url"))
    result["normalized_company"] = normalize_company(result.get("company"))
    if any(word.lower() in str(result.get("company") or "").lower() for word in WATCHLIST):
        result["priority"] = True
    result["canonical_job_key"] = canonical_job_key(
        result.get("apply_url") or result.get("job_url"), result.get("company")
    )
    result["career_stage"] = classify_career_stage(result.get("title"))
    result["priority_tier"] = priority_tier(result.get("title"))
    fit, viability, reason = score_job(result)
    result["fit_score"] = fit
    result["viability_score"] = viability
    result["discovery_suppressed_reason"] = reason
    return result
