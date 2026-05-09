#!/usr/bin/env python3
"""Upload and optionally publish the C3 extension through Chrome Web Store API v2."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.package_c3_extension import package_extension  # noqa: E402

API_ROOT = "https://chromewebstore.googleapis.com"


def _env(name: str, value: str | None = None) -> str:
    resolved = value or os.environ.get(name, "")
    if not resolved:
        raise RuntimeError(f"Missing {name}")
    return resolved


def _request(
    url: str,
    *,
    token: str,
    method: str = "POST",
    body: bytes | None = None,
    content_type: str | None = None,
) -> dict[str, object]:
    headers = {"Authorization": f"Bearer {token}"}
    if content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw) if raw else {}


def upload_package(
    *,
    publisher_id: str,
    extension_id: str,
    token: str,
    zip_path: Path,
    dry_run: bool,
) -> dict[str, object]:
    url = f"{API_ROOT}/upload/v2/publishers/{publisher_id}/items/{extension_id}:upload"
    print("[c3-store] upload_url:", url)
    print("[c3-store] zip:", zip_path)
    if dry_run:
        return {"dryRun": True, "step": "upload"}
    return _request(
        url,
        token=token,
        body=zip_path.read_bytes(),
        content_type="application/zip",
    )


def publish_item(
    *,
    publisher_id: str,
    extension_id: str,
    token: str,
    dry_run: bool,
) -> dict[str, object]:
    url = f"{API_ROOT}/v2/publishers/{publisher_id}/items/{extension_id}:publish"
    print("[c3-store] publish_url:", url)
    if dry_run:
        return {"dryRun": True, "step": "publish"}
    return _request(url, token=token)


def fetch_status(
    *,
    publisher_id: str,
    extension_id: str,
    token: str,
    dry_run: bool,
) -> dict[str, object]:
    url = f"{API_ROOT}/v2/publishers/{publisher_id}/items/{extension_id}:fetchStatus"
    print("[c3-store] status_url:", url)
    if dry_run:
        return {"dryRun": True, "step": "status"}
    return _request(url, token=token, method="GET")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--publisher-id", default=None)
    parser.add_argument("--extension-id", default=None)
    parser.add_argument("--token", default=None)
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    try:
        publisher_id = _env("CWS_PUBLISHER_ID", args.publisher_id)
        extension_id = _env("CWS_EXTENSION_ID", args.extension_id)
        token = _env("CWS_ACCESS_TOKEN", args.token)

        package = package_extension(dry_run=args.dry_run)
        zip_path = Path(package["zip_path"])
        upload_result = upload_package(
            publisher_id=publisher_id,
            extension_id=extension_id,
            token=token,
            zip_path=zip_path,
            dry_run=args.dry_run,
        )
        print("[c3-store] upload_result:", json.dumps(upload_result, indent=2))

        if args.publish:
            publish_result = publish_item(
                publisher_id=publisher_id,
                extension_id=extension_id,
                token=token,
                dry_run=args.dry_run,
            )
            print("[c3-store] publish_result:", json.dumps(publish_result, indent=2))

        if args.status:
            status_result = fetch_status(
                publisher_id=publisher_id,
                extension_id=extension_id,
                token=token,
                dry_run=args.dry_run,
            )
            print("[c3-store] status_result:", json.dumps(status_result, indent=2))

        print("[c3-store] complete")
        return 0
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        print(f"[c3-store] HTTP {error.code}: {body}")
        return 1
    except (OSError, RuntimeError, urllib.error.URLError) as error:
        print(f"[c3-store] error: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
