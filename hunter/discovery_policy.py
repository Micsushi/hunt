"""Deterministic C1 discovery policy shared by every source adapter."""

from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from hunter.config import TITLE_BLACKLIST, WATCHLIST
from hunter.search_lanes import canonicalize_title_text, matching_search_lane

DISCOVERY_POLICY_VERSION = 12

EMPLOYER_ALIASES = {
    "amazon web services": "amazon",
    "aws": "amazon",
    "bank of montreal": "bmo",
    "bmo financial group": "bmo",
    "canadian imperial bank of commerce": "cibc",
    "demonware": "activision",
    "dragonfly": "intelcom",
    "equitable bank": "eq bank",
    "intelcom": "intelcom",
    "loblaw digital": "loblaw",
    "mda space students": "mda space",
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
    try:
        parts = urlsplit(raw)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
        return None
    if parts.username is not None:
        return None
    query = [
        (key, item)
        for key, item in parse_qsl(parts.query, keep_blank_values=True)
        if not key.lower().startswith("utm_") and key.lower() not in TRACKING_QUERY_KEYS
    ]
    host = (parts.hostname or "").lower()
    netloc = f"[{host}]" if ":" in host else host
    if port is not None and (parts.scheme.lower(), port) not in {("https", 443), ("http", 80)}:
        netloc = f"{netloc}:{port}"
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
    if host == "jobs.smartrecruiters.com":
        match = re.fullmatch(r"/([^/]+)/(\d+)(?:-[^/]*)?", path)
        if match:
            return f"smartrecruiters:{match[1].lower()}:{match[2]}"
    if (
        host.endswith(".taleo.net")
        and re.fullmatch(r"/careersection/[^/]+/jobdetail\.ftl", parts.path)
        and query.get("job", "").isdigit()
    ):
        return f"taleo:{host}:{query['job']}"
    if host == "app.bchydro.com":
        from hunter.discovery_sap import posting_identity

        try:
            return f"sap:{host}:{posting_identity(normalized)}"
        except ValueError:
            pass
    if host == "careers.worksafebc.com" and query.get("offerid", "").isdigit():
        return f"technomedia:{host}:{query['offerid']}"
    if (
        path.startswith("/psc/")
        and path.endswith("/HRS_HRAM_FL.HRS_CG_SEARCH_FL.GBL")
        and query.get("JobOpeningId", "").isdigit()
    ):
        return f"peoplesoft:{host}:{path}:{query['JobOpeningId']}"
    if host in {"recruiting.ultipro.ca", "recruiting.ultipro.com"}:
        board = re.fullmatch(r"/([A-Za-z0-9_-]+)/JobBoard/[0-9a-f-]{36}/OpportunityDetail", path)
        identity = query.get("opportunityId", "")
        if board and re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", identity, re.I):
            return f"ukg:{host}:{board[1].lower()}:{identity.lower()}"
    # BMO publishes the same Workday requisition in its Phenom career-page URL.
    if host == "jobs.bmo.com":
        match = re.fullmatch(r"/(?:ca|us)/(?:en|fr)/job/(R\d+)(?:/[^/]+)?", path, re.IGNORECASE)
        if match:
            return f"workday:bmo:{match[1].lower()}"
    if host == "careers.ibm.com":
        match = re.search(r"/careers/JobDetail(?:/[^/]+/(\d+))?/?$", path)
        identity = (match[1] or query.get("jobId", "")) if match else ""
        if identity.isdigit():
            return f"requisition:ibm:{identity}"
    if host.endswith(".bamboohr.com"):
        match = re.fullmatch(r"/careers/(\d+)", path)
        identity = match[1] if match else query.get("id") if path == "/jobs/view.php" else None
        if identity and identity.isdigit():
            return f"bamboohr:{host}:{identity}"
    if host.endswith(".oraclecloud.com"):
        match = re.search(r"/(?:job|jobs/preview)/(\d+)(?:/|$)", path)
        if match:
            return f"oracle:{host}:{match[1]}"
    if host == "apply.workable.com":
        match = re.fullmatch(r"/(?:[^/]+/)?j/([0-9a-f]{10})", path, re.IGNORECASE)
        if match:
            return f"workable:{match[1].lower()}"

    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io", "app.greenhouse.io"}:
        if (
            path == "/embed/job_app"
            and re.fullmatch(r"[a-zA-Z0-9_-]+", query.get("for", ""))
            and query.get("token", "").isdigit()
        ):
            return f"greenhouse:{query['for'].lower()}:{query['token']}"
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
    match = re.search(r"/(?:jobs|careers|job)/([0-9]+|[0-9a-f-]{6,})(?:/|$)", path, re.IGNORECASE)
    if match:
        return f"{host}:{match.group(1).lower()}"
    identity_query = urlencode(sorted(parse_qsl(parts.query, keep_blank_values=True)))
    return f"{host}{path}" + (f"?{identity_query}" if identity_query else "")


def classify_career_stage(title: object) -> str:
    from hunter.config import CAREER_STAGES, INCLUDE_EXPERIENCED_ROLES

    value = str(title or "")
    if SENIOR_TITLE.search(value):
        return (
            "experienced"
            if INCLUDE_EXPERIENCED_ROLES or "experienced" in CAREER_STAGES
            else "experienced_excluded"
        )
    if EARLY_TITLE.search(value):
        return "early_career"
    return "unstated_stretch"


def priority_tier(title: object) -> str:
    from hunter.config import _DEFAULT_SEARCH_TERMS, SEARCH_TERMS

    value = str(title or "")
    lane = matching_search_lane(value)
    if lane and SEARCH_TERMS.get(lane) != _DEFAULT_SEARCH_TERMS.get(lane):
        return "P1"  # Every explicitly selected occupation has the same priority.
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
        # SK also identifies Slovakia. Its numeric postcode is not a Canadian postal code.
        if re.search(r",\s*SK\s*,\s*\d{3}\s?\d{2}\b", place):
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
    from hunter.config import DISCOVERY_COUNTRIES

    if not DISCOVERY_COUNTRIES:
        return None
    aliases = {
        "ca": "canada",
        "can": "canada",
        "us": "united states",
        "usa": "united states",
        "uk": "united kingdom",
        "gb": "united kingdom",
    }
    countries = {aliases.get(normalize_text(c), normalize_text(c)) for c in DISCOVERY_COUNTRIES}
    value = normalize_text(location)
    if "canada" in countries and is_canadian_location(location):
        return None
    if any(
        re.search(r"\b" + re.escape(country) + r"\b", value) for country in countries - {"canada"}
    ):
        return None
    # Country-only codes and comma-delimited country fields are explicit evidence.
    for part in re.split(r"[,;|]", str(location or "")):
        if aliases.get(normalize_text(part)) in countries and normalize_text(part) != "ca":
            return None
    if normalize_text(location) in {
        "",
        "remote",
        "hybrid or remote",
        "worldwide",
        "remote worldwide",
        "anywhere",
        "americas",
        "remote americas",
        "north america",
        "remote north america",
        "global",
        "remote global",
    }:
        return "geography_unverified"
    return "outside_canada" if countries == {"canada"} else "outside_search_geography"


def outside_country(country):
    """Use an explicit country field ahead of ambiguous city/province abbreviations."""
    if not country:
        return False
    country = {
        "ca": "Canada",
        "can": "Canada",
        "us": "United States",
        "usa": "United States",
        "gb": "United Kingdom",
        "uk": "United Kingdom",
    }.get(str(country).lower(), country)
    return outside_geography(country)


def outside_geography(location):
    return geography_suppression(location) in {"outside_canada", "outside_search_geography"}


def normalize_employment_type(value):
    value = normalize_text(value).replace(" ", "")
    return {"contractor": "contract", "temp": "temporary"}.get(value, value)


def score_job(job: dict) -> tuple[int, int, str | None]:
    """Return fit, viability, and a non-destructive suppression reason."""
    from hunter.config import (
        _DEFAULT_SEARCH_TERMS,
        CAREER_STAGES,
        COMPANY_BLOCKLIST,
        EMPLOYMENT_TYPES,
        REMOTE_ONLY,
        SEARCH_TERMS,
    )

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

    title = canonicalize_title_text(job.get("title"))
    description = canonicalize_title_text(job.get("description"))
    lane = matching_search_lane(title)
    occupation_code_only = (
        bool(re.search(r"\bnoc(?:\s+code)?[\s:#()-]*\d{4,5}\b", title)) and not lane
    )
    food_qa = (
        lane in _DEFAULT_SEARCH_TERMS
        and SEARCH_TERMS.get(lane) == _DEFAULT_SEARCH_TERMS[lane]
        and bool(re.search(r"\b(?:qa|quality assurance)\b", title))
        and bool(re.search(r"\b(?:food safety|meat|seafood|fresh produce)\b", description))
        and not re.search(
            r"\b(?:software|hardware|firmware|embedded|electronics|electrical|robotics|sdet|selenium|playwright|cypress|api testing|test automation)\b",
            title + " " + description,
        )
    )
    reason = None
    if any(word.lower() in str(job.get("title") or "").lower() for word in TITLE_BLACKLIST):
        reason = "title_blacklist"
    elif normalize_company(job.get("company")) in {
        normalize_company(value) for value in COMPANY_BLOCKLIST
    }:
        reason = "company_blocklist"
    elif stage == "experienced_excluded":
        reason = "experienced_title"
    elif geography_reason := geography_suppression(job.get("location")):
        reason = geography_reason
    elif CAREER_STAGES and stage not in CAREER_STAGES:
        reason = "career_stage_excluded"
    elif REMOTE_ONLY and not job.get("is_remote"):
        reason = "remote_work_unverified"
    elif EMPLOYMENT_TYPES and not job.get("employment_type"):
        reason = "employment_type_unverified"
    elif EMPLOYMENT_TYPES and not {
        normalize_employment_type(value) for value in str(job.get("employment_type")).split(";")
    } & {normalize_employment_type(value) for value in EMPLOYMENT_TYPES}:
        reason = "employment_type_excluded"
    elif job.get("category") == "other" or occupation_code_only or food_qa:
        reason = "outside_search_lanes"
    elif job.get("apply_type") == "easy_apply":
        reason = "easy_apply_ineligible"
    elif result_url := normalize_job_url(job.get("apply_url")):
        if (urlsplit(result_url).hostname or "").lower().endswith("linkedin.com"):
            reason = "linkedin_only_apply_path"
    return max(0, min(fit, 100)), max(0, min(viability, 100)), reason


def annotate_job(job: dict) -> dict:
    result = dict(job)
    result["category"] = matching_search_lane(result.get("title")) or "other"
    result["job_url"] = normalize_job_url(result.get("job_url"))
    result["apply_url"] = normalize_job_url(result.get("apply_url"))
    result["normalized_company"] = normalize_company(result.get("company"))
    result["priority"] = any(
        word.lower() in str(result.get("company") or "").lower() for word in WATCHLIST
    )
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
