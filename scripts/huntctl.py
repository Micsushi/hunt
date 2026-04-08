#!/usr/bin/env python3
"""Compatibility forwarder: prefer `scripts/hunterctl.py` (C1 Hunter operator CLI)."""
import subprocess
import sys
from pathlib import Path

_repo = Path(__file__).resolve().parent.parent
_ctl = Path(__file__).resolve().parent / "hunterctl.py"
raise SystemExit(
    subprocess.run([sys.executable, str(_ctl)] + sys.argv[1:], cwd=_repo).returncode
)
