from __future__ import annotations

import os
from pathlib import Path

try:
    from hunter.dotenv import load_dotenv as _load_dotenv  # type: ignore
except Exception:  # pragma: no cover
    _load_dotenv = None  # type: ignore

REPO_ROOT = Path(__file__).resolve().parent.parent
if _load_dotenv is not None:
    try:
        _load_dotenv(REPO_ROOT / ".env", override=False)
    except Exception:
        pass
DEFAULT_OG_RESUME_PATH = REPO_ROOT / "main.tex"
DEFAULT_CANDIDATE_PROFILE_PATH = (
    REPO_ROOT / "fletcher" / "templates" / "candidate_profile.template.md"
)
DEFAULT_BULLET_LIBRARY_PATH = (
    REPO_ROOT / "fletcher" / "templates" / "bullet_library.template.md"
)
BASE_RESUMES_ROOT = REPO_ROOT / "fletcher" / "base_resumes"

# Stage 0 runtime layout contract. Actual server paths live outside the repo.
DEFAULT_RUNTIME_ROOT = Path(
    os.getenv("HUNT_RESUME_ARTIFACTS_DIR", "/home/michael/data/hunt/resumes")
)
ATTEMPTS_DIRNAME = "attempts"
AD_HOC_DIRNAME = "ad_hoc"

SECTION_ORDER = (
    "Education",
    "Experience",
    "Projects",
    "Technical Skills",
)

# heuristic: fast local rules only. ollama: refine classification + keywords via local Ollama (/api/chat).
DEFAULT_MODEL_BACKEND = os.getenv("HUNT_RESUME_MODEL_BACKEND", "heuristic").strip().lower()
DEFAULT_MODEL_NAME = os.getenv("HUNT_RESUME_MODEL_NAME", "deterministic-stage1")
OLLAMA_HOST = os.getenv("HUNT_OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_TIMEOUT_SEC = float(os.getenv("HUNT_OLLAMA_TIMEOUT_SEC", "120"))
OLLAMA_MODEL_NAME = os.getenv("HUNT_OLLAMA_MODEL", "qwen3:8b")
PROMPT_VERSION_TAG = "c2_v0.1"
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
