from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

from shared.file_utils import write_text as _shared_write_text
from shared.storage import write_json_artifact
from shared.timestamps import utc_now_stamp

from .config import AD_HOC_DIRNAME, ATTEMPTS_DIRNAME, resolve_runtime_root


def build_attempt_dir(
    *, job_id: int | None, role_family: str, ad_hoc_label: str | None = None
) -> Path:
    timestamp = f"{utc_now_stamp()}_{uuid.uuid4().hex[:8]}"
    runtime_root = resolve_runtime_root()
    if job_id is not None:
        return runtime_root / ATTEMPTS_DIRNAME / str(job_id) / f"{timestamp}_{role_family}"
    slug = ad_hoc_label or "manual"
    return runtime_root / AD_HOC_DIRNAME / f"{timestamp}_{slug}"


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_text(path: Path, content: str) -> str:
    return _shared_write_text(path, content)


def write_json(path: Path, payload: dict) -> str:
    return write_json_artifact(path, payload)


def file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
