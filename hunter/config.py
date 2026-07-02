import os as _os

from shared.config_utils import get_bool_env as _get_bool_env
from shared.config_utils import get_int_env as _get_int_env
from shared.config_utils import get_str_env as _get_str_env

try:
    from hunter.dotenv import load_dotenv as _load_dotenv  # type: ignore
except Exception:  # pragma: no cover
    _load_dotenv = None  # type: ignore

_ROOT = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))

# Optional local/dev env file support. Environment variables (systemd/Ansible/Docker)
# still take precedence; .env only fills missing values.
if _load_dotenv is not None:
    try:
        _load_dotenv(_os.path.join(_ROOT, ".env"), override=False)
    except Exception:
        pass

try:
    from hunter import user_config as _user_config
except Exception:  # pragma: no cover
    _user_config = None  # type: ignore

try:
    _USER_CONFIG = _user_config.load() if _user_config is not None else {}
except Exception:
    _USER_CONFIG = {}


def _config_value(name: str, default):
    if name in _os.environ:
        return None
    return _USER_CONFIG.get(name.lower(), default)


def _get_config_int(name: str, default: int) -> int:
    file_default = _config_value(name, default)
    return _get_int_env(name, file_default)


def _get_config_bool(name: str, default: bool) -> bool:
    file_default = _config_value(name, default)
    return _get_bool_env(name, file_default)


def _get_config_list(name: str, default: list[str]) -> list[str]:
    value = _config_value(name, default)
    if isinstance(value, list):
        return [str(item) for item in value if str(item).strip()]
    return default


def _get_config_dict(name: str, default: dict[str, list[str]]) -> dict[str, list[str]]:
    value = _config_value(name, default)
    if not isinstance(value, dict):
        return default
    clean: dict[str, list[str]] = {}
    for key, items in value.items():
        if not isinstance(items, list):
            continue
        clean[str(key)] = [str(item) for item in items if str(item).strip()]
    return clean or default


def get_db_path():
    return _os.path.abspath(
        _os.path.expanduser(_get_str_env("HUNT_DB_PATH", _os.path.join(_ROOT, "hunt.db")))
    )


# Backwards-compatible constant: prefer `get_db_path()` for runtime correctness.
DB_PATH = get_db_path()

# Postgres connection URL. When set, all components use Postgres instead of SQLite.
# Format: postgresql://user:password@host:5432/dbname
HUNT_DB_URL = _get_str_env("HUNT_DB_URL", "")

# Fernet key for encrypting linkedin_accounts.password_encrypted.
# Generate: python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
HUNT_CREDENTIAL_KEY = _get_str_env("HUNT_CREDENTIAL_KEY", "")

# Shared bearer token used by all component service APIs.
# C0 backend sends this token when calling C1/C2/C4 services.
# Each service validates it on every request.
# Leave blank in dev to disable auth on service APIs.
HUNT_SERVICE_TOKEN = _get_str_env("HUNT_SERVICE_TOKEN", "")

# Component service base URLs (used by C0 gateway to reach each service).
HUNT_HUNTER_URL = _get_str_env("HUNT_HUNTER_URL", "http://localhost:8001")
HUNT_FLETCHER_URL = _get_str_env("HUNT_FLETCHER_URL", "http://localhost:8002")
HUNT_COORDINATOR_URL = _get_str_env("HUNT_COORDINATOR_URL", "http://localhost:8003")

# Discovery runs one query per (lane, term). Broad board results are trimmed afterward:
# see hunter.search_lanes.LANE_TITLE_KEYWORDS (keep lanes aligned when you change terms).
_DEFAULT_SEARCH_TERMS = {
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
SEARCH_TERMS = _get_config_dict("SEARCH_TERMS", _DEFAULT_SEARCH_TERMS)

_DEFAULT_LOCATIONS = [
    "Canada",
    # "Remote",
]
LOCATIONS = _get_config_list("LOCATIONS", _DEFAULT_LOCATIONS)

SITES = _get_config_list("SITES", ["indeed", "linkedin"])

MAX_WORKERS = _get_config_int("MAX_WORKERS", 10)
RESULTS_WANTED = _get_config_int("RESULTS_WANTED", 500)
HOURS_OLD = _get_config_int(
    "HOURS_OLD", 24
)  # 24h lookback: job_url uniqueness handles dedup across runs
RUN_INTERVAL_SECONDS = _get_config_int("RUN_INTERVAL_SECONDS", 600)  # 10 minutes between runs
ENRICH_AFTER_SCRAPE = _get_config_bool("ENRICH_AFTER_SCRAPE", True)
LINKEDIN_FETCH_DESCRIPTION = _get_config_bool("LINKEDIN_FETCH_DESCRIPTION", True)
ENRICHMENT_BATCH_LIMIT = _get_config_int("ENRICHMENT_BATCH_LIMIT", 25)
ENRICHMENT_TIMEOUT_MS = _get_config_int("ENRICHMENT_TIMEOUT_MS", 45000)
ENRICHMENT_SLOW_MO_MS = _get_config_int("ENRICHMENT_SLOW_MO_MS", 0)
ENRICHMENT_HEADFUL = _get_config_bool("ENRICHMENT_HEADFUL", False)
ENRICHMENT_UI_VERIFY_BLOCKED = _get_config_bool("ENRICHMENT_UI_VERIFY_BLOCKED", False)
ENRICHMENT_MAX_ATTEMPTS = _get_config_int("ENRICHMENT_MAX_ATTEMPTS", 4)
ENRICHMENT_STALE_PROCESSING_MINUTES = _get_config_int("ENRICHMENT_STALE_PROCESSING_MINUTES", 30)
ENRICHMENT_ALERT_MIN_ATTEMPTS = _get_config_int("ENRICHMENT_ALERT_MIN_ATTEMPTS", 5)
ENRICHMENT_ALERT_FAILURE_RATE_PERCENT = _get_config_int("ENRICHMENT_ALERT_FAILURE_RATE_PERCENT", 50)
ENRICHMENT_ALERT_COOLDOWN_MINUTES = _get_config_int("ENRICHMENT_ALERT_COOLDOWN_MINUTES", 60)
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

_DEFAULT_WATCHLIST = [
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
WATCHLIST = _get_config_list("WATCHLIST", _DEFAULT_WATCHLIST)

_DEFAULT_TITLE_BLACKLIST = [
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
TITLE_BLACKLIST = _get_config_list("TITLE_BLACKLIST", _DEFAULT_TITLE_BLACKLIST)
