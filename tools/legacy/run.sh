#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/../.."

if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate
pip install -q -r scraper/requirements.txt

exec python scraper/runner.py
