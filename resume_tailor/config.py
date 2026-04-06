from __future__ import annotations

from pathlib import Path
import os


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OG_RESUME_PATH = REPO_ROOT / "main.tex"
DEFAULT_CANDIDATE_PROFILE_PATH = REPO_ROOT / "resume_tailor" / "templates" / "candidate_profile.template.md"
DEFAULT_BULLET_LIBRARY_PATH = REPO_ROOT / "resume_tailor" / "templates" / "bullet_library.template.md"

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
