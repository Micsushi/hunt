#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -x ".venv/bin/python" ]; then
  exec .venv/bin/python scripts/uictl.py "$@"
elif [ -x "venv/bin/python" ]; then
  exec venv/bin/python scripts/uictl.py "$@"
else
  exec python3 scripts/uictl.py "$@"
fi

