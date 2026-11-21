"""Verify the most recent main-push CI run for an immutable Hunt release."""

import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path


def checkout_revision(root: Path) -> str:
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()


def verify_release_ci(revision: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ValueError("The Hunt release must be a full Git commit SHA.")
    url = (
        "https://api.github.com/repos/Micsushi/hunt/actions/workflows/ci.yml/runs"
        f"?branch=main&event=push&head_sha={revision}&per_page=1"
    )
    with urllib.request.urlopen(url, timeout=20) as response:
        runs = json.load(response)["workflow_runs"]
    if not runs:
        raise ValueError(f"No main-push CI run found for {revision}.")
    run = runs[0]
    if (
        run["head_sha"] != revision
        or run["event"] != "push"
        or run["head_branch"] != "main"
        or run["status"] != "completed"
        or run["conclusion"] != "success"
    ):
        raise ValueError(f"Release {revision} has no passing completed CI at {run['html_url']}.")
    print(f"[deploy] CI passed for {revision}: {run['html_url']}", flush=True)


if __name__ == "__main__":
    try:
        verify_release_ci(*sys.argv[1:])
    except (OSError, ValueError, KeyError) as exc:
        sys.exit(f"[deploy] Release check failed: {exc}")
