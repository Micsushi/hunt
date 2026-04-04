import os as _os
_ROOT = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
DB_PATH = _os.path.join(_ROOT, "hunt.db")

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

MAX_WORKERS = 10
RESULTS_WANTED = 500
HOURS_OLD = 24         # 24h lookback — job_url uniqueness handles dedup across runs
RUN_INTERVAL_SECONDS = 600   # 10 minutes between runs

WATCHLIST = [
    "1password", "adobe", "amazon", "amd", "apple", "atlassian",
    "bloomberg", "celestica", "cisco", "cloudflare", "connor, clark & lunn",
    "d2l", "datadog", "dell", "doordash", "drw",
    "flare", "google", "hashicorp", "hewlett packard", "hootsuite", "hp",
    "ibm", "meta", "microsoft", "okta",
    "paypal", "pcl", "pinterest", "qualcomm",
    "reddit", "robinhood", "salesforce", "sap", "shopify", "stripe",
    "uber", "unity", "vmware", "wealthsimple",
]

TITLE_BLACKLIST = [
    "master", "phd", "ph.d", "doctoral", "postdoc", "post-doc",
    "senior", "sr.", "sr ", "staff", "principal", "lead", "director",
    "vp ", "vice president", "head of", "chief ", "architect",
    # Higher than Tier I / Level 1
    "engineer ii", "engineer iii", "engineer iv", "engineer v",
    "developer ii", "developer iii", "developer iv",
    "analyst ii", "analyst iii", "scientist ii", "scientist iii",
    "level 2", "level 3", "level 4", "level 5",
    " l2", " l3", " l4", " l5", "l2 ", "l3 ", "l4 ", "l5 ",
    "tier 2", "tier 3", "tier 4", "tier ii", "tier iii", "tier iv",
    " ii ", " iii ", " iv ", " v ", " ii", " iii", " iv", " v ",
]
