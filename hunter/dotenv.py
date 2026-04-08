from __future__ import annotations

import os
from pathlib import Path


def load_dotenv(path: str | Path, *, override: bool = False) -> bool:
    """Load KEY=VALUE pairs from a .env file into os.environ.

    - Does nothing if file is missing.
    - Ignores blank lines and comments (# ...).
    - Does not override existing env vars unless override=True.
    """
    p = Path(path)
    if not p.exists() or not p.is_file():
        return False

    changed = False
    for raw_line in p.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        value = value.strip().strip('"').strip("'")
        if not override and os.getenv(key) is not None:
            continue
        os.environ[key] = value
        changed = True
    return changed

