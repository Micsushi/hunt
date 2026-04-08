from __future__ import annotations

import re
from collections import Counter

# Words that appear everywhere and carry no signal for resume tailoring.
STOPWORDS = {
    # Articles / conjunctions / prepositions
    "the", "and", "with", "for", "that", "this", "you", "your", "our",
    "will", "from", "into", "have", "has", "using", "use", "not", "but",
    "are", "was", "were", "been", "being", "can", "may", "must", "shall",
    "who", "what", "when", "where", "how", "its", "their", "they", "them",
    "all", "any", "both", "each", "few", "more", "most", "other", "some",
    "such", "than", "too", "very", "just", "also", "well", "about", "above",
    "after", "before", "between", "during", "through", "under", "within",
    # Generic job-posting boilerplate
    "work", "working", "team", "teams", "job", "role", "roles", "position", "candidate",
    "experience", "required", "preferred", "requirements", "qualifications",
    "responsibilities", "ability", "strong", "excellent", "good", "great",
    "looking", "seeking", "join", "help", "support", "ensure", "provide",
    "including", "related", "relevant", "various", "across", "within",
    "company", "organization", "business", "environment", "opportunity",
    "skills", "skill", "knowledge", "understanding", "background",
    "minimum", "years", "year", "plus", "degree", "bachelor", "master",
    "equivalent", "demonstrated", "proven", "ability", "able", "make",
    "take", "build", "create", "develop", "implement", "manage", "drive",
    "lead", "own", "nice", "have", "collaborate", "define", "execute",
    "launch", "launches", "new", "cross", "functional", "strategy",
    "strategies", "analytical",
    # Job title words that appear in the JD but aren't useful keywords
    "senior", "junior", "mid", "staff", "principal", "director", "manager",
    "engineer", "developer", "designer", "analyst", "specialist", "associate",
    "intern", "lead", "head", "vp", "cto", "cpo",
    "backend", "frontend", "fullstack", "full-stack", "full stack",
    # Generic action verbs that add no signal
    "scalable", "deploy", "pipelines", "pipeline", "systems", "system",
    "solutions", "solution", "services", "service", "platform", "platforms",
    "tools", "tool", "processes", "process", "projects", "project",
    "initiatives", "initiative", "programs", "program",
}

# Well-known tech / domain phrases to match as multi-word units first.
# Order matters: longer / more specific phrases before shorter ones.
# ADD YOUR OWN: if a keyword keeps appearing in jobs you care about but
# isn't being extracted, add it here as a lowercase string.
KNOWN_TECH_PHRASES = [
    # ---- Languages (avoid "go" alone — too ambiguous; use "golang") ----
    "python", "java", "kotlin", "typescript", "javascript", "golang",
    "rust", "c++", "c#", "ruby", "php", "swift", "scala", "r",
    # ---- Frontend ----
    "react", "next.js", "vue.js", "angular", "svelte", "tailwind css",
    "tailwind", "html", "css", "sass", "webpack", "vite",
    # ---- Backend / frameworks ----
    "fastapi", "flask", "django", "spring boot", "express", "rails",
    "graphql", "rest api", "grpc", "websocket",
    # ---- Data / ML / AI ----
    "machine learning", "deep learning", "large language model", "llm",
    "generative ai", "retrieval-augmented generation", "rag",
    "data analysis", "data science", "data engineering",
    "natural language processing", "nlp", "computer vision",
    "pandas", "numpy", "scikit-learn", "tensorflow", "pytorch",
    "spark", "apache spark", "airflow", "apache airflow",
    "dbt", "looker", "tableau", "power bi", "metabase",
    "sql", "nosql", "etl", "data pipeline", "data warehouse",
    "snowflake", "bigquery", "redshift",
    # ---- Infra / cloud / devops ----
    "aws", "gcp", "google cloud", "azure", "microsoft azure",
    "docker", "kubernetes", "k8s", "terraform", "ansible",
    "ci/cd", "github actions", "jenkins", "gitlab ci", "circleci",
    "postgresql", "mysql", "sqlite", "redis", "mongodb",
    "elasticsearch", "opensearch", "kafka", "rabbitmq", "celery",
    "serverless", "lambda", "cloud functions",
    # ---- Observability / reliability ----
    "datadog", "prometheus", "grafana", "opentelemetry", "sentry",
    "new relic", "pagerduty", "splunk",
    # ---- Security ----
    "oauth", "sso", "saml", "zero trust", "penetration testing",
    # ---- PM / strategy / process ----
    "product management", "product roadmap", "product strategy",
    "product discovery", "product-led growth", "plg",
    "agile", "scrum", "kanban", "safe", "lean",
    "okr", "kpi", "north star metric",
    "a/b testing", "experimentation", "feature flags",
    "user research", "usability testing", "ux research",
    "stakeholder management", "cross-functional",
    "go-to-market", "gtm", "launch plan",
    "competitive analysis", "market research",
    "pricing strategy", "monetization",
    "customer journey", "customer success",
    "business requirements", "product requirements",
    "sprint planning", "backlog grooming", "sprint review",
    # ---- Finance / business domain ----
    "financial modeling", "financial analysis", "forecasting",
    "p&l", "revenue growth", "cost reduction",
    "excel", "google sheets",
    # ---- Design / UX ----
    "figma", "sketch", "adobe xd", "invision",
    "design system", "component library",
    # ---- General tech / architecture ----
    "microservices", "event-driven", "domain-driven design", "ddd",
    "api", "sdk", "saas", "paas", "iaas",
    "b2b", "b2c", "b2b2c", "enterprise software",
    "mobile", "ios", "android", "react native", "flutter",
    "system design", "distributed systems",
    # ---- Telecom / device (add your own industry terms here) ----
    "device pricing", "acquisition", "wireless", "telecom",
]


def _normalize(text: str) -> str:
    return text.lower()


def _phrase_in_text(phrase: str, text: str) -> bool:
    """Return True only when the phrase appears as a whole word / phrase in text.

    Single-letter or ambiguous short tokens (r, c, go) are matched as whole
    words only to avoid false positives like 'r' inside 'required'.
    Multi-word phrases are matched as substrings (they are already specific enough).
    """
    if " " in phrase:
        return phrase in text
    # For single tokens, require word boundaries.
    return bool(re.search(r"(?<![a-zA-Z0-9])" + re.escape(phrase) + r"(?![a-zA-Z0-9])", text))


def _is_noise_token(token: str) -> bool:
    """Return True for tokens that are too generic to be useful keywords."""
    if token in STOPWORDS:
        return True
    # Pure numbers or very short tokens
    if len(token) <= 2:
        return True
    if re.fullmatch(r"\d+", token):
        return True
    return False


def extract_keywords(*, title: str, description: str | None, classification: dict) -> dict:
    text = _normalize(f"{title}\n{description or ''}")
    concern_flags = list(classification.get("concern_flags", []))

    # --- Step 1: match known multi-word tech phrases first ---
    matched_phrases: list[str] = []
    for phrase in KNOWN_TECH_PHRASES:
        if _phrase_in_text(phrase, text) and phrase not in matched_phrases:
            matched_phrases.append(phrase)

    # --- Step 2: extract single tokens that appear ≥2 times and aren't noise ---
    tokens = re.findall(r"[a-zA-Z][a-zA-Z0-9.+#/-]{2,}", text)
    counts = Counter(
        token for token in tokens
        if not _is_noise_token(token)
        # skip tokens already covered by a matched phrase
        and not any(token in phrase.split() for phrase in matched_phrases)
        # skip tokens that end in punctuation (sentence fragments leaking through)
        and re.fullmatch(r"[a-zA-Z][a-zA-Z0-9.+#/-]*[a-zA-Z0-9]", token)
    )

    # --- Step 3: build must_have_terms (max 10, meaningful only) ---
    # Start with matched tech phrases (highest signal), then add high-frequency tokens.
    must_haves: list[str] = list(matched_phrases[:10])
    if len(must_haves) < 10:
        for token, count in counts.most_common(30):
            if count < 2:
                # Only include tokens that appear at least twice — single mentions
                # are usually boilerplate, not real requirements.
                break
            if token not in must_haves:
                must_haves.append(token)
            if len(must_haves) >= 10:
                break

    # --- Step 4: nice_to_have_terms (max 8, no overlap with must_haves) ---
    nice_to_haves: list[str] = []
    for token, count in counts.most_common(40):
        if token not in must_haves and token not in nice_to_haves:
            nice_to_haves.append(token)
        if len(nice_to_haves) >= 8:
            break

    # --- Step 5: tools_and_technologies (tech phrases only) ---
    tools_and_technologies = list(matched_phrases[:12])

    # --- Step 6: domain_terms (non-tech high-frequency terms) ---
    domain_terms: list[str] = []
    for token, _ in counts.most_common(20):
        if token not in must_haves and token not in nice_to_haves:
            domain_terms.append(token)
        if len(domain_terms) >= 6:
            break

    # --- Step 7: responsibilities (first 6 sentences from JD) ---
    responsibilities = [
        sentence.strip()
        for sentence in re.split(r"(?<=[.!?])\s+", description or "")
        if len(sentence.strip()) > 20
    ][:6]

    seniority_signals = (
        [classification.get("job_level")]
        if classification.get("job_level") not in (None, "unknown")
        else []
    )

    if not description or len(description.strip()) < 120:
        if "weak_description" not in concern_flags:
            concern_flags.append("weak_description")

    return {
        "must_have_terms": must_haves,
        "nice_to_have_terms": nice_to_haves,
        "responsibilities": responsibilities,
        "tools_and_technologies": tools_and_technologies,
        "domain_terms": domain_terms,
        "seniority_signals": seniority_signals,
        "concern_flags": concern_flags,
    }
