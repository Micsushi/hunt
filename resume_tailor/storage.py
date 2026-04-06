from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

from .config import AD_HOC_DIRNAME, ATTEMPTS_DIRNAME, DEFAULT_RUNTIME_ROOT


def utc_now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def build_attempt_dir(*, job_id: int | None, role_family: str, ad_hoc_label: str | None = None) -> Path:
    timestamp = utc_now_stamp()
    if job_id is not None:
        return DEFAULT_RUNTIME_ROOT / ATTEMPTS_DIRNAME / str(job_id) / f"{timestamp}_{role_family}"
    slug = ad_hoc_label or "manual"
    return DEFAULT_RUNTIME_ROOT / AD_HOC_DIRNAME / f"{timestamp}_{slug}"


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_text(path: Path, content: str) -> str:
    ensure_dir(path.parent)
    path.write_text(content, encoding="utf-8")
    return str(path)


def write_json(path: Path, payload: dict) -> str:
    ensure_dir(path.parent)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return str(path)


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
