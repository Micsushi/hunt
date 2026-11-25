"""Role and career-level tags used by the personal fit review."""

from typing import Literal, get_args

FitRole = Literal["software", "ml_engineering", "data", "it", "business", "other", "unknown"]
FitSeniority = Literal["intern", "new_grad", "junior", "above_junior", "unknown"]
FitTier = Literal["p1", "p2", "p3", "p4", "p5", "outside_scope"]
ROLES = get_args(FitRole)
SENIORITY_LEVELS = get_args(FitSeniority)
DECISIONS = ("yes", "no", "deferred")
MAX_REVIEW_SESSIONS = 10

TIER_SQL = """CASE
    WHEN personal_fit_role IS NULL THEN NULL
    WHEN personal_fit = 'no' THEN 'outside_scope'
    WHEN personal_fit = 'yes' AND personal_fit_seniority IN ('intern', 'new_grad', 'junior') THEN
        CASE
            WHEN personal_fit_role IN ('software', 'ml_engineering') THEN
                CASE WHEN personal_fit_seniority = 'intern' THEN 'p2' ELSE 'p1' END
            WHEN personal_fit_role = 'data' THEN 'p3'
            WHEN personal_fit_role = 'it' THEN 'p4'
            WHEN personal_fit_role = 'business' THEN 'p5'
        END
    END"""


def validate_fit_decision(decision, role, seniority):
    if decision not in DECISIONS or role not in ROLES or seniority not in SENIORITY_LEVELS:
        raise ValueError("Every decision needs a supported fit, role and seniority.")
    if seniority == "above_junior" or role == "other":
        return "no"
    if decision == "yes" and (role == "unknown" or seniority == "unknown"):
        return "deferred"
    return decision
