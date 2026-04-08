import os as _os


def _get_str_env(name, default):
    value = _os.getenv(name)
    if value is None:
        return default
    value = value.strip()
    return value if value else default


def _get_int_env(name, default):
    value = _os.getenv(name)
    if value is None or not value.strip():
        return default
    return int(value)


def _get_bool_env(name, default):
    value = _os.getenv(name)
    if value is None or not value.strip():
        return default

    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


_ROOT = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))


def get_db_path():
    return _os.path.abspath(
        _os.path.expanduser(_get_str_env("HUNT_DB_PATH", _os.path.join(_ROOT, "hunt.db")))
    )


# Backwards-compatible constant: prefer `get_db_path()` for runtime correctness.
DB_PATH = get_db_path()

# Discovery runs one query per (lane, term). Broad board results are trimmed afterward:
# see hunter.search_lanes.LANE_TITLE_KEYWORDS (keep lanes aligned when you change terms).
SEARCH_TERMS = {
    "engineering": [
        "software engineer intern",
        "software engineer new grad",
        "junior software engineer",
        "software developer intern",
        "software developer new grad",
        "junior software developer",
        "frontend developer intern",
        "backend developer intern",
        "fullstack developer intern",
    ],
    "product": [
        "product manager intern",
        "product manager new grad",
        "junior product manager",
        "associate product manager",
        "project manager intern",
        "project manager new grad",
        "scrum master junior",
        "scrum master intern",
        "business analyst intern",
        "business analyst new grad",
    ],
    "data": [
        "data analyst intern",
        "data analyst new grad",
        "junior data analyst",
        "data scientist intern",
        "data scientist new grad",
        "junior data scientist",
        "data engineer intern",
        "data engineer new grad",
        "junior data engineer",
    ],
}

LOCATIONS = [
    "Canada",
    # "Remote",
]

SITES = ["indeed", "linkedin"]

MAX_WORKERS = _get_int_env("MAX_WORKERS", 10)
RESULTS_WANTED = _get_int_env("RESULTS_WANTED", 500)
HOURS_OLD = _get_int_env(
    "HOURS_OLD", 24
)  # 24h lookback: job_url uniqueness handles dedup across runs
RUN_INTERVAL_SECONDS = _get_int_env("RUN_INTERVAL_SECONDS", 600)  # 10 minutes between runs
ENRICH_AFTER_SCRAPE = _get_bool_env("ENRICH_AFTER_SCRAPE", True)
ENRICHMENT_BATCH_LIMIT = _get_int_env("ENRICHMENT_BATCH_LIMIT", 25)
ENRICHMENT_TIMEOUT_MS = _get_int_env("ENRICHMENT_TIMEOUT_MS", 45000)
ENRICHMENT_SLOW_MO_MS = _get_int_env("ENRICHMENT_SLOW_MO_MS", 0)
ENRICHMENT_HEADFUL = _get_bool_env("ENRICHMENT_HEADFUL", False)
ENRICHMENT_UI_VERIFY_BLOCKED = _get_bool_env("ENRICHMENT_UI_VERIFY_BLOCKED", False)
ENRICHMENT_MAX_ATTEMPTS = _get_int_env("ENRICHMENT_MAX_ATTEMPTS", 4)
ENRICHMENT_STALE_PROCESSING_MINUTES = _get_int_env("ENRICHMENT_STALE_PROCESSING_MINUTES", 30)
REVIEW_APP_HOST = _get_str_env("REVIEW_APP_HOST", "127.0.0.1")
REVIEW_APP_PORT = _get_int_env("REVIEW_APP_PORT", 8000)
REVIEW_APP_PUBLIC_URL = _get_str_env("REVIEW_APP_PUBLIC_URL", "https://agent-hunt-review.mshi.ca")
# Optional : require this bearer token for mutating review-app POST APIs (empty = disabled).
REVIEW_OPS_TOKEN = _get_str_env("REVIEW_OPS_TOKEN", "")
# Max rows a single bulk requeue from the review UI may touch.
REVIEW_BULK_REQUEUE_MAX = _get_int_env("REVIEW_BULK_REQUEUE_MAX", 500)
# Max rows per request for checkbox-driven bulk actions (requeue, set status).
REVIEW_BULK_SELECTED_MAX = _get_int_env("REVIEW_BULK_SELECTED_MAX", 250)
# Max rows per request for bulk delete (guards accidents).
REVIEW_BULK_DELETE_MAX = _get_int_env("REVIEW_BULK_DELETE_MAX", 50)

WATCHLIST = [
    "1password",
    "adobe",
    "amazon",
    "amd",
    "apple",
    "atlassian",
    "bloomberg",
    "celestica",
    "cisco",
    "cloudflare",
    "connor, clark & lunn",
    "d2l",
    "datadog",
    "dell",
    "doordash",
    "drw",
    "flare",
    "google",
    "hashicorp",
    "hewlett packard",
    "hootsuite",
    "hp",
    "ibm",
    "meta",
    "microsoft",
    "okta",
    "paypal",
    "pcl",
    "pinterest",
    "qualcomm",
    "reddit",
    "robinhood",
    "salesforce",
    "sap",
    "shopify",
    "stripe",
    "uber",
    "unity",
    "vmware",
    "wealthsimple",
]

TITLE_BLACKLIST = [
    "master",
    "phd",
    "ph.d",
    "doctoral",
    "postdoc",
    "post-doc",
    "senior",
    "sr.",
    "sr ",
    "staff",
    "principal",
    "lead",
    "director",
    "vp ",
    "vice president",
    "head of",
    "chief ",
    "architect",
    # Higher than Tier I / Level 1
    "engineer ii",
    "engineer iii",
    "engineer iv",
    "engineer v",
    "developer ii",
    "developer iii",
    "developer iv",
    "analyst ii",
    "analyst iii",
    "scientist ii",
    "scientist iii",
    "level 2",
    "level 3",
    "level 4",
    "level 5",
    " l2",
    " l3",
    " l4",
    " l5",
    "l2 ",
    "l3 ",
    "l4 ",
    "l5 ",
    "tier 2",
    "tier 3",
    "tier 4",
    "tier ii",
    "tier iii",
    "tier iv",
    " ii ",
    " iii ",
    " iv ",
    " v ",
    " ii",
    " iii",
    " iv",
    " v ",
]
