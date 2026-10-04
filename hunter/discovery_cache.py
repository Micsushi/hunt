"""Bounded public GET cache; reuse requires the origin's conditional-request validation."""

import os
import sqlite3
import time
from pathlib import Path

from hunter.user_config import get_path


def _path():
    return (
        Path(os.environ.get("HUNT_DISCOVERY_CACHE_DIR", str(get_path().parent / ".state")))
        / "discovery-http.sqlite"
    )


def cached_response(url):
    path = _path()
    if not path.is_file():
        return None
    connection = sqlite3.connect(path, timeout=5)
    try:
        row = connection.execute(
            "SELECT etag, modified, body, encoding FROM responses WHERE url = ?", (url,)
        ).fetchone()
        return row
    except sqlite3.OperationalError:
        return None
    finally:
        connection.close()


def cache_response(url, response, body):
    headers = response.headers
    etag, modified = headers.get("ETag"), headers.get("Last-Modified")
    control = str(headers.get("Cache-Control", "")).lower()
    cacheable = not (
        (not isinstance(etag, str) and not isinstance(modified, str))
        or len(body) > 5_000_000
        or "no-store" in control
        or "private" in control
        or headers.get("Vary") == "*"
        or headers.get("Set-Cookie")
    )
    path = _path()
    if not cacheable and not path.is_file():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=5)
    try:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS responses (url TEXT PRIMARY KEY, etag TEXT, modified TEXT, body BLOB, encoding TEXT, checked REAL)"
        )
        if not cacheable:
            connection.execute("DELETE FROM responses WHERE url = ?", (url,))
            connection.commit()
            return
        connection.execute(
            "INSERT OR REPLACE INTO responses VALUES (?, ?, ?, ?, ?, ?)",
            (
                url,
                etag if isinstance(etag, str) else None,
                modified if isinstance(modified, str) else None,
                body,
                headers.get_content_charset() or "utf-8-sig",
                time.time(),
            ),
        )
        # Public catalogs and descriptions only. Bound disk use as well as entry age.
        connection.execute("DELETE FROM responses WHERE checked < ?", (time.time() - 7 * 86400,))
        size = connection.execute(
            "SELECT coalesce(sum(length(body)), 0) FROM responses"
        ).fetchone()[0]
        if size > 128_000_000:
            connection.execute(
                "DELETE FROM responses WHERE url IN (SELECT url FROM responses ORDER BY checked LIMIT (SELECT max(1, count(*) / 4) FROM responses))"
            )
        connection.commit()
    finally:
        connection.close()


def decode_body(body, encoding):
    try:
        return body.decode(encoding, errors="replace")
    except LookupError:
        return body.decode("utf-8-sig", errors="replace")
