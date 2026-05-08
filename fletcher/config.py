from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from shared.paths import REPO_ROOT

try:
    from hunter.dotenv import load_dotenv as _load_dotenv  # type: ignore
except Exception:  # pragma: no cover
    _load_dotenv = None  # type: ignore
if _load_dotenv is not None:
    try:
        _load_dotenv(REPO_ROOT / ".env", override=False)
    except Exception:
        pass
DEFAULT_OG_RESUME_PATH = REPO_ROOT / "main.tex"
DEFAULT_MASTER_RESUME_PATH = REPO_ROOT / "fletcher" / "master_resume.yaml"
DEFAULT_MASTER_RESUME_TEMPLATE_PATH = (
    REPO_ROOT / "fletcher" / "templates" / "master_resume.template.yaml"
)

_candidate_profile_real = REPO_ROOT / "fletcher" / "candidate_profile.md"
_candidate_profile_template = REPO_ROOT / "fletcher" / "templates" / "candidate_profile.template.md"
DEFAULT_CANDIDATE_PROFILE_PATH = (
    _candidate_profile_real if _candidate_profile_real.exists() else _candidate_profile_template
)

_bullet_library_real = REPO_ROOT / "fletcher" / "bullet_library.md"
_bullet_library_template = REPO_ROOT / "fletcher" / "templates" / "bullet_library.template.md"
DEFAULT_BULLET_LIBRARY_PATH = (
    _bullet_library_real if _bullet_library_real.exists() else _bullet_library_template
)
BASE_RESUMES_ROOT = REPO_ROOT / "fletcher" / "base_resumes"

# Stage 0 runtime layout contract. Actual server paths live outside the repo.
_win_runtime_root = str(REPO_ROOT / ".runtime" / "resumes")
_default_runtime_root_str = os.getenv("HUNT_RESUME_ARTIFACTS_DIR") or (
    _win_runtime_root if os.name == "nt" else "/home/michael/data/hunt/resumes"
)
DEFAULT_RUNTIME_ROOT = Path(_default_runtime_root_str)
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
_INITIAL_DEFAULT_MODEL_BACKEND = DEFAULT_MODEL_BACKEND
DEFAULT_MODEL_NAME = os.getenv("HUNT_RESUME_MODEL_NAME", "deterministic-stage1")
RESUME_LLM_PROVIDER = os.getenv("HUNT_RESUME_LLM_PROVIDER", DEFAULT_MODEL_BACKEND).strip().lower()
RESUME_LLM_MODEL = os.getenv("HUNT_RESUME_LLM_MODEL", "").strip()
RESUME_LLM_TIMEOUT_SEC = float(os.getenv("HUNT_RESUME_LLM_TIMEOUT_SEC", "300"))
OLLAMA_HOST = os.getenv("HUNT_OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_TIMEOUT_SEC = float(os.getenv("HUNT_OLLAMA_TIMEOUT_SEC", "300"))
OLLAMA_MODEL_NAME = os.getenv("HUNT_OLLAMA_MODEL", "gemma4:e4b")
OLLAMA_KEEP_ALIVE = os.getenv("HUNT_OLLAMA_KEEP_ALIVE", "-1")
OLLAMA_NUM_PARALLEL = os.getenv("HUNT_OLLAMA_NUM_PARALLEL", "")
OLLAMA_CONTEXT_LENGTH = os.getenv("HUNT_OLLAMA_CONTEXT_LENGTH", "")
OLLAMA_FLASH_ATTENTION = os.getenv("HUNT_OLLAMA_FLASH_ATTENTION", "")
OLLAMA_KV_CACHE_TYPE = os.getenv("HUNT_OLLAMA_KV_CACHE_TYPE", "")
PROMPT_VERSION_TAG = "c2_v0.2_jd_keywords"


def ollama_keep_alive_payload() -> str | int:
    value = resume_runtime_setting("ollama_keep_alive", "HUNT_OLLAMA_KEEP_ALIVE", OLLAMA_KEEP_ALIVE)
    value = value.strip()
    if value in {"-1", "0"} or value.isdigit():
        return int(value)
    return value


def _setting_value(key: str) -> str:
    if os.getenv("PYTEST_CURRENT_TEST") and not os.getenv("HUNT_DB_PATH"):
        return ""
    try:
        from .db import get_connection

        conn = get_connection()
        try:
            row = conn.execute(
                """
                SELECT value
                FROM component_settings
                WHERE component = 'c2' AND key = ?
                """,
                (key,),
            ).fetchone()
        finally:
            conn.close()
    except Exception:
        return ""
    return str(row["value"] or "").strip() if row else ""


def resume_runtime_setting(key: str, env_name: str, default: str = "") -> str:
    return _setting_value(key) or os.getenv(env_name, "").strip() or default


def resume_runtime_bool(key: str, env_name: str, default: bool = False) -> bool:
    fallback = "1" if default else "0"
    value = resume_runtime_setting(key, env_name, fallback).strip().lower()
    return value in {"1", "true", "yes", "on"}


def resume_runtime_float(key: str, env_name: str, default: float) -> float:
    value = resume_runtime_setting(key, env_name, str(default))
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def resume_runtime_int(key: str, env_name: str, default: int, *, minimum: int = 0) -> int:
    value = resume_runtime_setting(key, env_name, str(default))
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, parsed)


def resume_llm_provider() -> str:
    if (
        os.getenv("PYTEST_CURRENT_TEST")
        and DEFAULT_MODEL_BACKEND != _INITIAL_DEFAULT_MODEL_BACKEND
        and DEFAULT_MODEL_BACKEND in {"heuristic", "none"}
    ):
        return DEFAULT_MODEL_BACKEND
    provider = resume_runtime_setting("llm_provider", "HUNT_RESUME_LLM_PROVIDER", "")
    if provider:
        return provider.lower()
    legacy = resume_runtime_setting(
        "model_backend", "HUNT_RESUME_MODEL_BACKEND", DEFAULT_MODEL_BACKEND
    )
    return "ollama" if legacy.lower() == "ollama" else "heuristic"


def resume_llm_model(task_name: str | None = None) -> str:
    if task_name:
        value = resume_runtime_setting(
            f"{task_name.lower()}_model",
            f"HUNT_RESUME_{task_name.upper()}_MODEL",
            "",
        )
        if value:
            return value
    return resume_runtime_setting("llm_model", "HUNT_RESUME_LLM_MODEL", RESUME_LLM_MODEL)


def resume_cloud_llm_confirmed() -> bool:
    return resume_runtime_bool("cloud_llm_confirm", "HUNT_RESUME_CLOUD_LLM_CONFIRM", False)


def resume_provider_api_key(provider: str, env_name: str) -> str:
    return resume_runtime_setting(f"{provider}_api_key", env_name, "")


def ollama_host() -> str:
    return resume_runtime_setting("ollama_host", "HUNT_OLLAMA_HOST", OLLAMA_HOST).rstrip("/")


def ollama_model_name() -> str:
    return resume_runtime_setting("ollama_model", "HUNT_OLLAMA_MODEL", OLLAMA_MODEL_NAME)


def ollama_timeout_sec() -> float:
    return resume_runtime_float("ollama_timeout_sec", "HUNT_OLLAMA_TIMEOUT_SEC", OLLAMA_TIMEOUT_SEC)


def bullet_rewrite_runtime() -> dict[str, Any]:
    return {
        "parallelism": resume_runtime_int(
            "bullet_rewrite_parallelism",
            "HUNT_BULLET_REWRITE_PARALLELISM",
            BULLET_REWRITE_PARALLELISM,
            minimum=1,
        ),
        "min_available_mb": resume_runtime_int(
            "bullet_rewrite_min_available_mb",
            "HUNT_BULLET_REWRITE_MIN_AVAILABLE_MB",
            BULLET_REWRITE_MIN_AVAILABLE_MB,
            minimum=0,
        ),
        "max_memory_pct": min(
            100,
            resume_runtime_int(
                "bullet_rewrite_max_memory_pct",
                "HUNT_BULLET_REWRITE_MAX_MEMORY_PCT",
                BULLET_REWRITE_MAX_MEMORY_PCT,
                minimum=1,
            ),
        ),
    }


# RAG : vector index for keyword-to-bullet semantic matching.
OLLAMA_EMBED_MODEL = os.getenv("HUNT_OLLAMA_EMBED_MODEL", "mxbai-embed-large")
_default_rag_dir = str(DEFAULT_RUNTIME_ROOT / "rag_index")
RAG_INDEX_DIR = Path(os.getenv("HUNT_RAG_INDEX_DIR", _default_rag_dir))
RAG_SIMILARITY_THRESHOLD = float(
    os.getenv("HUNT_RAG_SIMILARITY_THRESHOLD", "0.60")
)  # kept for index query CLI
RAG_HIGH_THRESHOLD = float(
    os.getenv("HUNT_RAG_HIGH_THRESHOLD", "0.60")
)  # keyword -> rewrite that bullet
RAG_MID_THRESHOLD = float(os.getenv("HUNT_RAG_MID_THRESHOLD", "0.35"))  # keyword -> summary only
RAG_MAX_SUMMARY_KEYWORDS = int(os.getenv("HUNT_RAG_MAX_SUMMARY_KEYWORDS", "5"))
RAG_ENABLED = os.getenv("HUNT_RAG_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"}

# Bullet rewrite LLM calls can run concurrently when memory guard allows it.
BULLET_REWRITE_PARALLELISM = max(1, int(os.getenv("HUNT_BULLET_REWRITE_PARALLELISM", "5")))
BULLET_REWRITE_MIN_AVAILABLE_MB = max(
    0, int(os.getenv("HUNT_BULLET_REWRITE_MIN_AVAILABLE_MB", "4096"))
)
BULLET_REWRITE_MAX_MEMORY_PCT = max(
    1, min(100, int(os.getenv("HUNT_BULLET_REWRITE_MAX_MEMORY_PCT", "85")))
)

# Optional debugging: write LLM prompt/response to attempt_dir.
# On by default for resume generation so slow runs are inspectable.
# Disable explicitly with: HUNT_RESUME_LOG_LLM_IO=0
LOG_LLM_IO = os.getenv("HUNT_RESUME_LOG_LLM_IO", "1").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
LOG_LLM_MAX_CHARS = int(os.getenv("HUNT_RESUME_LOG_LLM_MAX_CHARS", "120000"))
DEFAULT_MAX_EXPERIENCE_BULLETS = 8
DEFAULT_MAX_PROJECT_BULLETS = 3
DEFAULT_MAX_TOTAL_BULLETS = 12
DEFAULT_MAX_BULLETS_PER_EXP_ENTRY = int(os.getenv("HUNT_MAX_BULLETS_PER_EXP_ENTRY", "6"))


def get_db_path() -> Path:
    return Path(os.getenv("HUNT_DB_PATH", REPO_ROOT / "hunt.db")).expanduser().resolve()


def resolve_runtime_root() -> Path:
    return Path(os.getenv("HUNT_RESUME_ARTIFACTS_DIR", str(DEFAULT_RUNTIME_ROOT)))


def resolve_base_resume_path(role_family: str) -> tuple[str, Path]:
    normalized_family = (role_family or "general").strip().lower()
    if normalized_family and normalized_family != "general":
        family_dir = BASE_RESUMES_ROOT / normalized_family
        for file_name in ("main.tex", "resume.tex", "base.tex"):
            candidate = family_dir / file_name
            if candidate.exists():
                return normalized_family, candidate
    general = BASE_RESUMES_ROOT / "general" / "main.tex"
    if general.exists():
        return "general", general
    return "original", DEFAULT_OG_RESUME_PATH
