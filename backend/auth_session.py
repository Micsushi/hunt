"""Simple single-admin session auth for the C0 control plane.

Sessions stored in hunt SQLite DB. Replace on v0.4 with a proper users table.

Credentials from env vars:
  HUNT_ADMIN_USERNAME  (default: admin)
  HUNT_ADMIN_PASSWORD  (required — app logs a warning if empty)
"""
import hashlib
import hmac
import secrets
import sqlite3
import time
from contextlib import closing

from hunter.config import _get_str_env  # type: ignore

ADMIN_USERNAME: str = _get_str_env("HUNT_ADMIN_USERNAME", "admin")
ADMIN_PASSWORD: str = _get_str_env("HUNT_ADMIN_PASSWORD", "")

SESSION_TTL_SECONDS: int = 60 * 60 * 24 * 7  # 7 days
SESSION_COOKIE_NAME = "hunt_session"


def _get_db_path() -> str:
    """Lazy import to avoid circular dependency at module load time."""
    from hunter.config import get_db_path  # noqa: PLC0415
    return get_db_path()


def _conn() -> sqlite3.Connection:
    """Open a short-lived connection to the hunt DB."""
    conn = sqlite3.connect(_get_db_path())
    conn.row_factory = sqlite3.Row
    return conn


def init_sessions_table() -> None:
    """Create review_sessions table if it does not exist."""
    with closing(_conn()) as conn:
        with conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS review_sessions (
                    token      TEXT PRIMARY KEY,
                    username   TEXT    NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER NOT NULL
                )
            """)
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_sessions_expires"
                " ON review_sessions (expires_at)"
            )


def _unused_hash(password: str) -> str:
    """PBKDF2 hash — kept for future use when passwords are stored hashed."""
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), b"hunt-salt", 260_000
    ).hex()


def check_credentials(username: str, password: str) -> bool:
    """Return True if username+password match the configured admin credentials."""
    if not ADMIN_PASSWORD:
        return False
    if username != ADMIN_USERNAME:
        return False
    return hmac.compare_digest(password, ADMIN_PASSWORD)


def create_session(username: str) -> str:
    """Insert a new session row and return the session token."""
    token = secrets.token_urlsafe(32)
    now = int(time.time())
    expires = now + SESSION_TTL_SECONDS
    with closing(_conn()) as conn:
        with conn:
            conn.execute(
                "INSERT INTO review_sessions"
                " (token, username, created_at, expires_at) VALUES (?,?,?,?)",
                (token, username, now, expires),
            )
    return token


def validate_session(token: str) -> str | None:
    """Return username if token is valid and not expired, else None."""
    if not token:
        return None
    now = int(time.time())
    with closing(_conn()) as conn:
        row = conn.execute(
            "SELECT username FROM review_sessions"
            " WHERE token = ? AND expires_at > ?",
            (token, now),
        ).fetchone()
    return row["username"] if row else None


def delete_session(token: str) -> None:
    """Remove a session token (logout)."""
    with closing(_conn()) as conn:
        with conn:
            conn.execute(
                "DELETE FROM review_sessions WHERE token = ?", (token,)
            )


def purge_expired_sessions() -> None:
    """Delete all expired session rows."""
    now = int(time.time())
    with closing(_conn()) as conn:
        with conn:
            conn.execute(
                "DELETE FROM review_sessions WHERE expires_at <= ?", (now,)
            )
