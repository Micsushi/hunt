from __future__ import annotations

import os
from pathlib import Path

from shared.llm import config as llm_config
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

DEFAULT_DB_PATH = REPO_ROOT / "hunt.db"
DEFAULT_RUNTIME_ROOT = REPO_ROOT / ".state" / "coordinator"


def _resolve_path(value: str | Path | None, default: Path) -> Path:
    if value is None or not str(value).strip():
        path = default
    else:
        path = Path(str(value).strip()).expanduser()
        if not path.is_absolute():
            path = REPO_ROOT / path
    return path.resolve()


def resolve_db_path(value: str | Path | None = None) -> Path:
    return _resolve_path(value or os.getenv("HUNT_DB_PATH"), DEFAULT_DB_PATH)


def _runtime_root_from_env() -> str | None:
    return os.getenv("HUNT_COORDINATOR_ROOT") or os.getenv("HUNT_ORCHESTRATION_ROOT")


def resolve_runtime_root(value: str | Path | None = None) -> Path:
    return _resolve_path(value or _runtime_root_from_env(), DEFAULT_RUNTIME_ROOT)


def c4_llm_provider() -> str:
    return llm_config.choose_provider(component="c4", default="ollama").provider


def c4_llm_model() -> str:
    return llm_config.choose_model(
        component="c4",
        default=os.getenv("HUNT_OLLAMA_MODEL", "gemma2:9b").strip(),
    )


def hermes_command() -> str:
    configured = os.getenv("HUNT_HERMES_COMMAND", "").strip()
    if configured:
        return configured
    local = (
        Path(os.getenv("LOCALAPPDATA", ""))
        / "hermes"
        / "hermes-agent"
        / "venv"
        / "Scripts"
        / "hermes.exe"
    )
    if local.exists():
        return str(local)
    return "hermes"


def hermes_max_turns() -> str:
    return os.getenv("HUNT_HERMES_MAX_TURNS", "12").strip() or "12"
