from __future__ import annotations

from pathlib import Path
import os


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OG_RESUME_PATH = REPO_ROOT / "main.tex"
DEFAULT_CANDIDATE_PROFILE_PATH = REPO_ROOT / "resume_tailor" / "templates" / "candidate_profile.template.md"
DEFAULT_BULLET_LIBRARY_PATH = REPO_ROOT / "resume_tailor" / "templates" / "bullet_library.template.md"
BASE_RESUMES_ROOT = REPO_ROOT / "resume_tailor" / "base_resumes"

# Stage 0 runtime layout contract. Actual server paths live outside the repo.
DEFAULT_RUNTIME_ROOT = Path(os.getenv("HUNT_RESUME_ARTIFACTS_DIR", "/home/michael/data/hunt/resumes"))
ATTEMPTS_DIRNAME = "attempts"
AD_HOC_DIRNAME = "ad_hoc"

SECTION_ORDER = (
    "Education",
    "Experience",
    "Projects",
    "Technical Skills",
)

DEFAULT_MODEL_BACKEND = os.getenv("HUNT_RESUME_MODEL_BACKEND", "heuristic")
DEFAULT_MODEL_NAME = os.getenv("HUNT_RESUME_MODEL_NAME", "deterministic-stage1")
DEFAULT_MAX_EXPERIENCE_BULLETS = 8
DEFAULT_MAX_PROJECT_BULLETS = 3
DEFAULT_MAX_TOTAL_BULLETS = 12


def get_db_path() -> Path:
    return Path(os.getenv("HUNT_DB_PATH", REPO_ROOT / "hunt.db")).expanduser().resolve()


def resolve_base_resume_path(role_family: str) -> tuple[str, Path]:
    normalized_family = (role_family or "general").strip().lower()
    if normalized_family and normalized_family != "general":
        family_dir = BASE_RESUMES_ROOT / normalized_family
        for file_name in ("main.tex", "resume.tex", "base.tex"):
            candidate = family_dir / file_name
            if candidate.exists():
                return normalized_family, candidate
    return "original", DEFAULT_OG_RESUME_PATH
