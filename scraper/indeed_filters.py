import unicodedata


INDEED_CATEGORY_KEYWORDS = {
    "engineering": (
        "software",
        "developer",
        "engineer",
        "frontend",
        "front-end",
        "backend",
        "back-end",
        "fullstack",
        "full stack",
        "web developer",
        "application developer",
        "devops",
        "sdet",
        "qa engineer",
        ".net",
        "ingenieur",
        "developpeur",
        "logiciel",
    ),
    "product": (
        "product",
        "project manager",
        "project management",
        "scrum",
        "business analyst",
        "business analysis",
        "product owner",
        "associate product manager",
        "program manager",
        "gestionnaire de produit",
        "chef de produit",
        "analyste d'affaires",
        "analyste daffaires",
    ),
    "data": (
        "data",
        "analytics",
        "scientist",
        "machine learning",
        "business intelligence",
        "bi developer",
        "bi analyst",
        "analyste de donnees",
        "scientifique des donnees",
        "donnees",
    ),
}


def canonicalize_text(value):
    if not value or not isinstance(value, str):
        return ""
    normalized = unicodedata.normalize("NFKD", value)
    without_accents = "".join(char for char in normalized if not unicodedata.combining(char))
    return " ".join(without_accents.lower().split())


def matches_indeed_category(title, category):
    if not title or not isinstance(title, str):
        return False

    keywords = INDEED_CATEGORY_KEYWORDS.get(category)
    if not keywords:
        return True

    title_key = canonicalize_text(title)
    return any(keyword in title_key for keyword in keywords)
