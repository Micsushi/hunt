DB_PATH = "hunt.db"

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

SITES = ["indeed", "linkedin", "glassdoor"]

MAX_WORKERS = 3

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
    "senior", "staff", "principal", "lead", "director",
]
